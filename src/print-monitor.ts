/**
 * Print Monitor — Background AI vision monitoring for active prints.
 *
 * Captures camera snapshots on a configurable interval, checks MQTT status
 * for hardware errors, and runs AI vision analysis to detect failures like
 * spaghetti, detachment, or printing into air. Sends emergency stop on failure.
 *
 * Dependencies are injected (snapshot fn, MQTT client, vision provider)
 * so this module has no direct coupling to the MCP server or AI SDK.
 */

import * as fs from "fs";
import * as path from "path";
import type { BambuMQTTClient } from "./mqtt-client.js";
import type {
  VisionProvider,
  VisionAnalysisResult,
} from "./vision-provider.js";

export interface MonitorConfig {
  intervalSeconds: number;
  minLayerForVision: number;
  host: string;
  accessCode: string;
  snapshotDir: string;
}

export interface MonitorState {
  active: boolean;
  cycleCount: number;
  lastVerdict: VisionAnalysisResult | null;
  lastSnapshotPath: string | null;
  failureDetected: boolean;
  failureReason: string | null;
  emergencyStopSent: boolean;
  printState: string | null;
  printPercent: number | null;
  layer: number | null;
  totalLayers: number | null;
  errors: string[];
}

export interface MonitorDeps {
  captureSnapshot: (
    host: string,
    accessCode: string,
    outputPath: string,
  ) => Promise<string>;
  mqttClient: BambuMQTTClient;
  visionProvider: VisionProvider;
  onLog: (level: "info" | "warning" | "error", message: string) => void;
}

export class PrintMonitor {
  private config: MonitorConfig;
  private deps: MonitorDeps;
  private state: MonitorState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshotCount = 0;

  constructor(config: MonitorConfig, deps: MonitorDeps) {
    this.config = config;
    this.deps = deps;
    this.state = {
      active: false,
      cycleCount: 0,
      lastVerdict: null,
      lastSnapshotPath: null,
      failureDetected: false,
      failureReason: null,
      emergencyStopSent: false,
      printState: null,
      printPercent: null,
      layer: null,
      totalLayers: null,
      errors: [],
    };
  }

  start(): void {
    if (this.state.active) return;

    if (!fs.existsSync(this.config.snapshotDir)) {
      fs.mkdirSync(this.config.snapshotDir, { recursive: true });
    }

    this.state.active = true;
    this.deps.onLog(
      "info",
      `Monitor started: ${this.config.intervalSeconds}s interval, ` +
        `vision after layer ${this.config.minLayerForVision}, ` +
        `provider: ${this.deps.visionProvider.name}/${this.deps.visionProvider.model}`,
    );

    // Run first cycle immediately, then on interval
    this.monitorCycle();
    this.timer = setInterval(
      () => this.monitorCycle(),
      this.config.intervalSeconds * 1000,
    );
  }

  stop(): MonitorState {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state.active = false;
    this.deps.onLog(
      "info",
      `Monitor stopped after ${this.state.cycleCount} cycles`,
    );
    return this.getState();
  }

  getState(): MonitorState {
    return { ...this.state };
  }

  private async monitorCycle(): Promise<void> {
    if (!this.state.active) return;

    this.state.cycleCount++;
    const cycleNum = this.state.cycleCount;

    try {
      // 1. Get MQTT status
      const status = this.deps.mqttClient.getCachedStatus();
      const printState = (status.gcode_state as string) || "UNKNOWN";
      const percent = (status.mc_percent as number) || 0;
      const layer = (status.layer_num as number) || 0;
      const totalLayers = (status.total_layer_num as number) || 0;
      const printError = status.print_error as number | undefined;

      this.state.printState = printState;
      this.state.printPercent = percent;
      this.state.layer = layer;
      this.state.totalLayers = totalLayers;

      // 2. Capture snapshot
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const snapshotPath = path.join(
        this.config.snapshotDir,
        `monitor_${ts}_${++this.snapshotCount}.jpg`,
      );

      let savedPath: string;
      try {
        savedPath = await this.deps.captureSnapshot(
          this.config.host,
          this.config.accessCode,
          snapshotPath,
        );
        this.state.lastSnapshotPath = savedPath;
      } catch (snapErr: any) {
        const msg = `Cycle ${cycleNum}: snapshot failed: ${snapErr.message}`;
        this.state.errors.push(msg);
        this.deps.onLog("warning", msg);
        return; // Skip vision if snapshot fails — don't stop the print
      }

      this.deps.onLog(
        "info",
        `Cycle ${cycleNum}: ${path.basename(savedPath)} | ${printState} | ${percent}% | Layer ${layer}/${totalLayers}`,
      );

      // 3. MQTT failure detection
      if ((printError && printError !== 0) || printState === "FAILED") {
        const reason = printError
          ? `MQTT error code ${printError}`
          : "MQTT FAILED state";
        await this.handleFailure(reason);
        return;
      }

      // 4. Auto-stop on print completion
      if (printState === "FINISH") {
        this.deps.onLog("info", "Print complete — stopping monitor");
        this.stop();
        return;
      }

      // 5. AI Vision analysis (skip early layers)
      if (layer >= this.config.minLayerForVision) {
        try {
          const imageData = fs.readFileSync(savedPath);
          const base64 = imageData.toString("base64");
          const prompt = buildVisionPrompt(layer, totalLayers, percent);

          const verdict = await this.deps.visionProvider.analyze(
            base64,
            prompt,
          );
          this.state.lastVerdict = verdict;

          if (verdict.failed) {
            await this.handleFailure(`Vision: ${verdict.reason}`);
            return;
          }

          this.deps.onLog(
            "info",
            `Cycle ${cycleNum}: Vision OK (${verdict.latencyMs}ms) — ${verdict.reason.slice(0, 80)}`,
          );
        } catch (visionErr: any) {
          // Vision API errors are non-fatal — don't stop the print
          const msg = `Cycle ${cycleNum}: vision error: ${visionErr.message}`;
          this.state.errors.push(msg);
          this.deps.onLog("warning", msg);
        }
      } else {
        this.deps.onLog(
          "info",
          `Cycle ${cycleNum}: skipping vision (layer ${layer} < ${this.config.minLayerForVision})`,
        );
      }
    } catch (err: any) {
      const msg = `Cycle ${cycleNum}: unexpected error: ${err.message}`;
      this.state.errors.push(msg);
      this.deps.onLog("error", msg);
    }
  }

  private async handleFailure(reason: string): Promise<void> {
    this.state.failureDetected = true;
    this.state.failureReason = reason;

    this.deps.onLog("error", `FAILURE DETECTED: ${reason}`);
    this.deps.onLog("error", "Sending emergency stop...");

    try {
      await this.deps.mqttClient.stopPrint();
      this.state.emergencyStopSent = true;
      this.deps.onLog("error", "Emergency stop sent");
    } catch (stopErr: any) {
      this.deps.onLog(
        "error",
        `Failed to send stop command: ${stopErr.message}`,
      );
    }

    this.stop();
  }
}

// ===== Vision Prompt Builder =====

function buildVisionPrompt(
  layer: number,
  totalLayers: number,
  percent: number,
): string {
  const early = layer <= 5;
  const late = percent >= 80;

  let stageContext: string;
  if (early) {
    stageContext = `STAGE: Early print (layer ${layer}/${totalLayers || "?"}, ${percent}%). Only thin outlines, skirts, and first layers on the bed. Very little material is visible — this is NORMAL. Do NOT flag thin/sparse prints at this stage.`;
  } else if (late) {
    stageContext = `STAGE: Late print (layer ${layer}/${totalLayers || "?"}, ${percent}%). Objects should be nearly complete with full height and defined shapes.`;
  } else {
    stageContext = `STAGE: Mid print (layer ${layer}/${totalLayers || "?"}, ${percent}%). Objects should be visibly forming with stacked layers. Some height is expected.`;
  }

  return `You are a 3D print failure detector. You are analyzing a single camera frame from inside a Bambu Lab P1S 3D printer.

PRINTER CONTEXT:
- Camera: fixed wide-angle lens mounted low in the front-left of the chamber
- Build plate: textured PEI sheet, often has white/cloudy glue stick residue — this is NORMAL
- The toolhead moves fast and may appear blurred — this is NORMAL

${stageContext}

NORMAL — do NOT flag:
- Glue residue (white/cloudy smears on the build plate)
- Purge lines, purge blobs, or wipe towers at the plate edges (AMS filament changes leave small purge pieces — this is NORMAL)
- Skirt/brim outlines around objects
- Thin first layers during early print stages
- Motion blur on the toolhead or gantry
- Small wisps of stringing between nearby parts (cosmetic, not failure)
- Objects that look short/flat because the print is still early
- Small debris or filament scraps on the bed from previous prints or AMS purges

FAILURE — only flag these when CLEARLY visible:
- Spaghetti: a chaotic tangled mess of filament that is obviously NOT part of any structured print. Must look like a bird's nest or random loops.
- Detachment: a printed object has clearly fallen over, shifted position, or peeled entirely off the bed
- Printing into air: the nozzle is extruding filament high above the bed with NO object underneath it
- Blob: a large irregular molten mass engulfing the nozzle or print

CRITICAL RULES:
1. You MUST be conservative. A false positive stops the print and wastes time, material, and money.
2. If you are less than 90% confident it is a failure, say OK.
3. Glue residue is NOT stringing. Thin early layers are NOT detachment.
4. One image can be ambiguous — when in doubt, ALWAYS say OK.

Respond with EXACTLY one line:
VERDICT: OK
or
VERDICT: FAIL | <brief reason>`;
}
