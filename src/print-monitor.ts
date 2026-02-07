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
      // 0. Check MQTT is still connected
      if (!this.deps.mqttClient.isConnected()) {
        const msg = `Cycle ${cycleNum}: MQTT disconnected — status data is stale, skipping vision analysis`;
        this.state.errors.push(msg);
        this.deps.onLog("warning", msg);
        return;
      }

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
- Purge lines, purge blobs, or wipe towers ANYWHERE on the bed (AMS color changes drop purge blobs mid-print — these can appear suddenly at any time during a multi-color print and are completely NORMAL, even if they look like messy clumps of filament)
- Skirt/brim outlines around objects
- Thin first layers during early print stages
- Motion blur on the toolhead or gantry
- Small wisps of stringing between nearby parts (cosmetic, not failure)
- Objects that look short/flat because the print is still early
- ANY pre-existing objects, blobs, filament scraps, or debris sitting on the bed — these are leftovers from previous prints and are completely NORMAL. They may be colorful, tangled, or messy-looking but they are NOT an active failure.
- Static blobs or clumps of filament anywhere on the bed that are NOT connected to the nozzle

FAILURE — only flag these when CLEARLY and ACTIVELY happening:
- Spaghetti: filament being ACTIVELY extruded by the nozzle into a chaotic tangled mess instead of structured layers. The spaghetti must be connected to or growing from the nozzle/active print area. Static debris already sitting on the bed is NOT spaghetti.
- Detachment: a printed object has clearly fallen over, shifted position, or peeled entirely off the bed DURING this print
- Printing into air: the nozzle is extruding filament high above the bed with NO object underneath it

KEY DISTINCTION: Only flag ACTIVE failures — problems happening RIGHT NOW with the current print. Pre-existing objects, blobs, scraps, or debris on the bed from previous prints are NOT failures regardless of how messy they look.

CRITICAL RULES:
1. You MUST be conservative. A false positive stops the print and wastes time, material, and money.
2. If you are less than 95% confident it is an ACTIVE failure, say OK.
3. Glue residue is NOT stringing. Thin early layers are NOT detachment. Blobs on the bed are NOT spaghetti.
4. One image can be ambiguous — when in doubt, ALWAYS say OK.
5. If something looks messy but is NOT connected to the nozzle or active print, it is pre-existing debris — say OK.

Respond with EXACTLY one line:
VERDICT: OK
or
VERDICT: FAIL | <brief reason>`;
}
