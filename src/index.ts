#!/usr/bin/env node
/**
 * Bambu Lab MCP Server
 *
 * Complete MCP server for Bambu Lab 3D printers featuring:
 * - Local MQTT control (print, pause, resume, stop, speed, G-code)
 * - Real-time status with continuous caching from MQTT reports
 * - Camera snapshots (TLS stream on port 6000), recording, and timelapse
 * - AMS filament management
 * - FTP file upload (FTPS on port 990)
 * - X.509 certificate signing (bypass firmware auth restrictions)
 * - Cloud API for account/printer listing
 * - MakerWorld integration (download models for printing)
 *
 * Protocol reference: https://github.com/Doridian/OpenBambuAPI
 * X.509 background: https://hackaday.com/2025/01/19/bambu-connects-authentication-x-509-certificate-and-private-key-extracted/
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import { getAppCert, type BambuLabConfig } from "./types.js";
import { BambuMQTTClient, type MQTTConfig } from "./mqtt-client.js";
import * as crypto from "crypto";
import { Client as FTPClient } from "basic-ftp";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tls from "tls";
import { execFile, execFileSync } from "child_process";
import {
  makerWorldDownload,
  parseMakerWorldUrl,
  findRecent3mf,
} from "./makerworld.js";
import { PrintMonitor, type MonitorState } from "./print-monitor.js";
import { createVisionProvider } from "./vision-provider.js";

// ===== Speed Profiles (inspired by Shockedrope/bambu-mcp-server) =====

const SPEED_PROFILES: Record<string, number> = {
  silent: 50,
  standard: 100,
  sport: 125,
  ludicrous: 166,
};

// ===== Safety & Validation =====

const BLOCKED_GCODE_PREFIXES = [
  "M112", // Emergency stop (use printer_stop tool instead)
  "M502", // Factory reset
  "M500", // Save settings to EEPROM
  "M501", // Restore settings from EEPROM
  "M997", // Firmware update
  "M999", // Restart after emergency stop
];

const SAFE_TEMP_LIMITS = {
  nozzle: 300,
  bed: 120,
};

const ALLOWED_UPLOAD_EXTENSIONS = [".gcode", ".3mf", ".stl"];

function validateGcode(gcode: string): string | null {
  const upper = gcode.trim().toUpperCase();

  for (const prefix of BLOCKED_GCODE_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return `G-code ${prefix} is blocked for safety. Use the appropriate MCP tool instead.`;
    }
  }

  const tempMatch = upper.match(/^M10[49]\s+S(\d+)/);
  if (tempMatch) {
    const temp = parseInt(tempMatch[1]);
    if (temp > SAFE_TEMP_LIMITS.nozzle) {
      return `Nozzle temperature ${temp}C exceeds safe limit of ${SAFE_TEMP_LIMITS.nozzle}C`;
    }
  }

  const bedTempMatch = upper.match(/^M140\s+S(\d+)/);
  if (bedTempMatch) {
    const temp = parseInt(bedTempMatch[1]);
    if (temp > SAFE_TEMP_LIMITS.bed) {
      return `Bed temperature ${temp}C exceeds safe limit of ${SAFE_TEMP_LIMITS.bed}C`;
    }
  }

  return null;
}

function validateFTPPath(localPath: string): string | null {
  const resolved = path.resolve(localPath);
  const ext = path.extname(resolved).toLowerCase();

  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
    return `File extension "${ext}" not allowed. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}`;
  }

  if (!fs.existsSync(resolved)) {
    return `File not found: ${resolved}`;
  }

  return null;
}

function validateRemotePath(remotePath: string): string | null {
  if (remotePath.includes("..") || remotePath.startsWith("/")) {
    return `Invalid remote path: must be a relative filename without ".." traversal`;
  }
  return null;
}

// ===== Slicer Integration =====

/**
 * Locate an installed slicer CLI (OrcaSlicer preferred, BambuStudio fallback).
 */
function findSlicerBinary(): string | null {
  const candidates = [
    "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
    "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Find bundled printer profiles from the slicer installation.
 */
function findSlicerProfiles(slicerBin: string): {
  machine: string;
  process: string;
  filament: string;
} | null {
  const resourcesDir = path.join(
    path.dirname(slicerBin),
    "..",
    "Resources",
    "profiles",
    "BBL",
  );
  const machine = path.join(
    resourcesDir,
    "machine",
    "Bambu Lab P1S 0.4 nozzle.json",
  );
  const process_ = path.join(
    resourcesDir,
    "process",
    "0.20mm Standard @BBL P1P.json",
  );
  let filament = path.join(
    resourcesDir,
    "filament",
    "P1P",
    "Generic PLA @BBL P1P.json",
  );
  if (!fs.existsSync(filament)) {
    filament = path.join(resourcesDir, "filament", "Generic PLA @BBL P1P.json");
  }
  if (
    !fs.existsSync(machine) ||
    !fs.existsSync(process_) ||
    !fs.existsSync(filament)
  ) {
    return null;
  }
  return { machine, process: process_, filament };
}

/**
 * Check if a 3MF file is already sliced (contains gcode inside).
 */
function is3mfSliced(filePath: string): boolean {
  try {
    const output = execFileSync("unzip", ["-l", filePath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.includes("plate_1.gcode") || output.includes("plate_2.gcode");
  } catch {
    return false;
  }
}

/**
 * Patch out-of-range config values in a 3MF that newer BambuStudio creates
 * but older OrcaSlicer rejects.
 */
function patch3mfForOrcaSlicer(extractDir: string): void {
  const configPath = path.join(
    extractDir,
    "Metadata",
    "project_settings.config",
  );
  if (!fs.existsSync(configPath)) return;
  let config = fs.readFileSync(configPath, "utf-8");
  const patches: [RegExp, string][] = [
    [
      /"raft_first_layer_expansion":\s*"-1"/g,
      '"raft_first_layer_expansion": "0"',
    ],
    [/"solid_infill_filament":\s*"0"/g, '"solid_infill_filament": "1"'],
    [/"sparse_infill_filament":\s*"0"/g, '"sparse_infill_filament": "1"'],
    [/"tree_support_wall_count":\s*"-1"/g, '"tree_support_wall_count": "0"'],
    [/"wall_filament":\s*"0"/g, '"wall_filament": "1"'],
  ];
  for (const [pattern, replacement] of patches) {
    config = config.replace(pattern, replacement);
  }
  fs.writeFileSync(configPath, config);
}

/**
 * Slice a 3MF file using OrcaSlicer/BambuStudio CLI.
 * Returns path to the sliced 3MF containing gcode.
 */
async function slice3mf(
  inputPath: string,
  outputPath?: string,
): Promise<string> {
  if (is3mfSliced(inputPath)) {
    return inputPath;
  }

  const slicer = findSlicerBinary();
  if (!slicer) {
    throw new Error(
      "No slicer found. Install OrcaSlicer (brew install --cask orcaslicer) or BambuStudio.",
    );
  }

  const profiles = findSlicerProfiles(slicer);
  if (!profiles) {
    throw new Error(
      "Could not find P1S printer profiles in slicer installation.",
    );
  }

  const outFile = outputPath || inputPath.replace(/\.3mf$/i, "_sliced.3mf");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-slice-"));

  try {
    // Extract 3MF (it's a ZIP archive)
    execFileSync("unzip", ["-o", inputPath, "-d", tmpDir], { stdio: "pipe" });

    // Patch config for OrcaSlicer compatibility
    patch3mfForOrcaSlicer(tmpDir);

    // Repackage patched 3MF
    const patchedPath = path.join(tmpDir, "patched.3mf");
    execFileSync("zip", ["-r", patchedPath, "."], {
      cwd: tmpDir,
      stdio: "pipe",
    });

    // Copy profiles to temp dir (avoids path-with-spaces issues in CLI args)
    fs.copyFileSync(profiles.machine, path.join(tmpDir, "machine.json"));
    fs.copyFileSync(profiles.process, path.join(tmpDir, "process.json"));
    fs.copyFileSync(profiles.filament, path.join(tmpDir, "filament.json"));

    // Slice via CLI
    return new Promise((resolve, reject) => {
      execFile(
        slicer,
        [
          "--allow-newer-file",
          "--no-check",
          "--load-settings",
          "machine.json;process.json",
          "--load-filaments",
          "filament.json",
          "--slice",
          "0",
          "--export-3mf",
          outFile,
          "patched.3mf",
        ],
        { cwd: tmpDir, timeout: 120000 },
        (error, _stdout, stderr) => {
          try {
            fs.rmSync(tmpDir, { recursive: true });
          } catch {}
          if (error) {
            reject(new Error(`Slicer failed: ${stderr || error.message}`));
            return;
          }
          if (!fs.existsSync(outFile)) {
            reject(new Error("Slicer produced no output file"));
            return;
          }
          resolve(outFile);
        },
      );
    });
  } catch (error: any) {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}
    throw error;
  }
}

// ===== Camera Snapshot =====

/**
 * Capture a single JPEG frame from the printer's camera stream.
 *
 * Protocol (reverse-engineered from HA Bambulab integration):
 * - TLS connection to port 6000
 * - 80-byte auth: 16-byte header + 32-byte username + 32-byte access code
 * - Frames arrive as: 16-byte header (payload size in bytes 0-2 LE) + JPEG data
 */
function captureSnapshot(
  host: string,
  accessCode: string,
  outputPath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      { host, port: 6000, rejectUnauthorized: false },
      () => {
        const auth = Buffer.alloc(80, 0);
        auth.writeUInt32LE(0x40, 0);
        auth.writeUInt32LE(0x3000, 4);
        Buffer.from("bblp", "ascii").copy(auth, 16);
        Buffer.from(accessCode, "ascii").copy(auth, 48);
        sock.write(auth);
      },
    );

    let pending = Buffer.alloc(0);
    let payloadSize = 0;
    let frameBuf: Buffer | null = null;
    let done = false;

    sock.on("data", (chunk) => {
      if (done) return;
      pending = Buffer.concat([pending, chunk]);

      while (pending.length > 0 && !done) {
        if (frameBuf === null) {
          if (pending.length < 16) break;
          payloadSize = pending[0] | (pending[1] << 8) | (pending[2] << 16);
          frameBuf = Buffer.alloc(0);
          pending = pending.subarray(16);
        } else {
          const needed = payloadSize - frameBuf.length;
          const take = Math.min(needed, pending.length);
          frameBuf = Buffer.concat([frameBuf, pending.subarray(0, take)]);
          pending = pending.subarray(take);

          if (frameBuf.length === payloadSize) {
            const validStart = frameBuf[0] === 0xff && frameBuf[1] === 0xd8;
            const validEnd =
              frameBuf[frameBuf.length - 2] === 0xff &&
              frameBuf[frameBuf.length - 1] === 0xd9;

            if (validStart && validEnd) {
              fs.writeFileSync(outputPath, frameBuf);
              done = true;
              sock.destroy();
              resolve(outputPath);
              return;
            }
            frameBuf = null;
          }
        }
      }
    });

    sock.on("error", (err) => {
      if (!done) reject(new Error(`Camera stream error: ${err.message}`));
    });

    setTimeout(() => {
      if (!done) {
        sock.destroy();
        reject(new Error("Camera snapshot timed out (10s)"));
      }
    }, 10000);
  });
}

// ===== Configuration =====

const BASE_URL =
  process.env.BAMBU_LAB_BASE_URL || "https://bambulab.com/api/v1";
const AUTH_COOKIES = process.env.BAMBU_LAB_COOKIES || "";
const APP_CERT_ID =
  process.env.BAMBU_LAB_APP_CERT_ID ||
  "GLOF3813734089-524a37c80000c6a6a274a47b3281";

const MQTT_HOST = process.env.BAMBU_LAB_MQTT_HOST || "";
const MQTT_PORT = parseInt(process.env.BAMBU_LAB_MQTT_PORT || "8883");
const MQTT_USERNAME = process.env.BAMBU_LAB_MQTT_USERNAME || "bblp";
const MQTT_PASSWORD = process.env.BAMBU_LAB_MQTT_PASSWORD || "";
const MQTT_DEVICE_ID = process.env.BAMBU_LAB_DEVICE_ID || "";

// ===== Helpers =====

function ok(data: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string, details?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: message, ...(details ? { details } : {}) },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

// ===== MCP Server =====

class BambuLabMCP {
  private config: BambuLabConfig;
  private server: Server;
  private mqttClient: BambuMQTTClient | null = null;
  private printMonitor: PrintMonitor | null = null;

  constructor() {
    this.config = {
      baseUrl: BASE_URL,
      cookies: AUTH_COOKIES,
      appCertId: APP_CERT_ID,
    };

    this.server = new Server(
      { name: "bambu-lab-mcp", version: "3.1.0" },
      { capabilities: { tools: {}, logging: {} } },
    );

    this.setupHandlers();
    this.initMQTT();
  }

  private async initMQTT() {
    if (MQTT_HOST && MQTT_PASSWORD && MQTT_DEVICE_ID) {
      try {
        const config: MQTTConfig = {
          host: MQTT_HOST,
          port: MQTT_PORT,
          username: MQTT_USERNAME,
          password: MQTT_PASSWORD,
          deviceId: MQTT_DEVICE_ID,
        };

        this.mqttClient = new BambuMQTTClient(config);
        await this.mqttClient.connect();
        console.error("[bambu-mcp] MQTT connected to", MQTT_HOST);
      } catch (error: any) {
        console.error("[bambu-mcp] MQTT connection failed:", error.message);
      }
    } else {
      console.error(
        "[bambu-mcp] MQTT not configured — set BAMBU_LAB_MQTT_HOST, BAMBU_LAB_MQTT_PASSWORD, BAMBU_LAB_DEVICE_ID",
      );
    }
  }

  private requireMQTT(): BambuMQTTClient {
    if (!this.mqttClient || !this.mqttClient.isConnected()) {
      throw new Error("MQTT not connected. Use mqtt_connect first.");
    }
    return this.mqttClient;
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        return await this.dispatch(name, args as any);
      } catch (error: any) {
        console.error(`[bambu-mcp] Tool ${name} failed:`, error.message);
        return err(error.message);
      }
    });
  }

  private async dispatch(name: string, args: any): Promise<any> {
    // Cloud API
    if (name === "get_user_profile") return await this.getUserProfile();
    if (name === "list_printers") return await this.listPrinters();
    if (name === "get_printer_status") return await this.getPrinterStatus(args);
    if (name === "sign_message") return await this.signMessage(args);

    // MQTT connection
    if (name === "mqtt_connect") return await this.mqttConnect(args);
    if (name === "mqtt_disconnect") return await this.mqttDisconnect();

    // Print control
    if (name === "printer_stop") return await this.printerStop();
    if (name === "printer_pause") return await this.printerPause();
    if (name === "printer_resume") return await this.printerResume();
    if (name === "printer_set_speed") return await this.printerSetSpeed(args);
    if (name === "printer_send_gcode") return await this.printerSendGcode(args);
    if (name === "printer_print_file") return await this.printerPrintFile(args);
    if (name === "printer_get_status") return await this.printerGetStatus();
    if (name === "printer_get_cached_status")
      return this.printerGetCachedStatus();
    if (name === "printer_get_version") return await this.printerGetVersion();

    // Object control
    if (name === "skip_objects") return await this.skipObjects(args);

    // AMS
    if (name === "ams_change_filament")
      return await this.amsChangeFilament(args);
    if (name === "ams_unload_filament") return await this.amsUnloadFilament();

    // Camera
    if (name === "camera_record") return await this.cameraRecord(args);
    if (name === "camera_timelapse") return await this.cameraTimelapse(args);
    if (name === "camera_snapshot") return await this.cameraSnapshot(args);

    // Vision Monitor
    if (name === "monitor_start") return await this.monitorStart(args);
    if (name === "monitor_status") return this.monitorStatus();
    if (name === "monitor_stop") return this.monitorStop();

    // LED
    if (name === "led_control") return await this.ledControl(args);

    // Hardware
    if (name === "set_nozzle") return await this.setNozzle(args);

    // Temperature
    if (name === "set_temperature") return await this.setTemperature(args);

    // FTP
    if (name === "ftp_upload_file") return await this.ftpUploadFile(args);

    // MakerWorld
    if (name === "makerworld_download")
      return await this.makerWorldDownload(args);
    if (name === "makerworld_print") return await this.makerWorldPrint(args);
    if (name === "slice_3mf") return await this.slice3mfTool(args);
    if (name === "ams_filament_mapping") return this.amsFilamentMapping();

    return err(`Unknown tool: ${name}`);
  }

  // ===== Tool Definitions =====

  private getTools(): Tool[] {
    return [
      // --- Cloud API ---
      {
        name: "get_user_profile",
        description: "Get Bambu Lab cloud account profile",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "list_printers",
        description: "List all printers registered to the cloud account",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_printer_status",
        description:
          "Get printer status via cloud API (requires cloud cookies)",
        inputSchema: {
          type: "object",
          properties: {
            device_id: { type: "string", description: "Printer device ID" },
          },
          required: ["device_id"],
        },
      },
      {
        name: "sign_message",
        description:
          "Sign a message with X.509 certificate for authenticated printer communication. Uses the extracted Bambu Connect certificate to bypass firmware auth restrictions.",
        inputSchema: {
          type: "object",
          properties: {
            device_id: { type: "string", description: "Printer device ID" },
            message: { type: "object", description: "Message payload to sign" },
          },
          required: ["device_id", "message"],
        },
      },

      // --- MQTT Connection ---
      {
        name: "mqtt_connect",
        description:
          "Connect to a Bambu Lab printer via local MQTT over TLS. Required before any printer control commands.",
        inputSchema: {
          type: "object",
          properties: {
            host: { type: "string", description: "Printer IP address" },
            port: {
              type: "number",
              description: "MQTT port (default: 8883)",
            },
            username: {
              type: "string",
              description: 'MQTT username (default: "bblp")',
            },
            password: {
              type: "string",
              description: "LAN access code from printer screen",
            },
            device_id: {
              type: "string",
              description: "Printer serial number",
            },
          },
          required: ["host", "password", "device_id"],
        },
      },
      {
        name: "mqtt_disconnect",
        description: "Disconnect from the MQTT printer connection",
        inputSchema: { type: "object", properties: {}, required: [] },
      },

      // --- Print Control ---
      {
        name: "printer_stop",
        description: "Stop the current print job immediately",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "printer_pause",
        description: "Pause the current print job",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "printer_resume",
        description: "Resume a paused print job",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "printer_set_speed",
        description:
          "Set print speed. Use a named profile (silent/standard/sport/ludicrous) or a percentage (1-166).",
        inputSchema: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              enum: ["silent", "standard", "sport", "ludicrous"],
              description: "Named speed profile",
            },
            speed: {
              type: "number",
              description:
                "Speed percentage (1-166). Ignored if profile is set.",
            },
          },
          required: [],
        },
      },
      {
        name: "printer_send_gcode",
        description:
          'Send a single G-code command to the printer (e.g., "G28" for home). Dangerous commands are blocked for safety.',
        inputSchema: {
          type: "object",
          properties: {
            gcode: { type: "string", description: "G-code command" },
          },
          required: ["gcode"],
        },
      },
      {
        name: "printer_print_file",
        description:
          "Start printing a file on the printer SD card (uploaded via ftp_upload_file). " +
          "Auto-detects .3mf vs .gcode — for .3mf files uses project_file command (requires Developer Mode). " +
          "For .3mf: ams_mapping maps print colors to AMS slots (index=color, value=slot 0-3 or -1 for external).",
        inputSchema: {
          type: "object",
          properties: {
            file: {
              type: "string",
              description:
                "Filename on printer storage (e.g. 'model.3mf' or 'print.gcode')",
            },
            plate: {
              type: "number",
              description: "Plate number for .3mf files (1-based, default: 1)",
            },
            ams_mapping: {
              type: "array",
              items: { type: "number" },
              description:
                "AMS slot mapping for .3mf files. Array index = color in file, value = AMS slot (0-3) or -1 for external. " +
                "Single color slot 0: [0]. Two colors: [0, 1]. Use ams_filament_mapping to check which slot has which filament.",
            },
            bed_type: {
              type: "string",
              enum: [
                "auto",
                "cool_plate",
                "engineering_plate",
                "textured_pei_plate",
              ],
              description: "Bed plate type (default: auto)",
            },
            timelapse: {
              type: "boolean",
              description: "Enable timelapse recording",
            },
            use_ams: {
              type: "boolean",
              description: "Use AMS for filament (default: true)",
            },
          },
          required: ["file"],
        },
      },

      // --- Status ---
      {
        name: "printer_get_status",
        description:
          "Request a full status push from the printer and return it. Includes temperatures, print progress, AMS state, fan speeds, and more. Note: pushall should not be called more than once every 5 minutes on P1P.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "printer_get_cached_status",
        description:
          "Return the last cached printer status without requesting a new push. Faster and lighter than printer_get_status — use this for frequent polling.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "printer_get_version",
        description:
          "Get firmware and module version information for the connected printer",
        inputSchema: { type: "object", properties: {}, required: [] },
      },

      // --- Object Control ---
      {
        name: "skip_objects",
        description:
          "Skip specific objects during a multi-object print. Useful for excluding failed parts without stopping the entire print.",
        inputSchema: {
          type: "object",
          properties: {
            object_ids: {
              type: "array",
              items: { type: "number" },
              description: "Array of object IDs to skip",
            },
          },
          required: ["object_ids"],
        },
      },

      // --- AMS ---
      {
        name: "ams_change_filament",
        description: "Change to a different AMS filament tray (0-3)",
        inputSchema: {
          type: "object",
          properties: {
            tray: {
              type: "number",
              description: "AMS tray number (0-3)",
            },
            target_temp: {
              type: "number",
              description: "Target nozzle temperature for the filament",
            },
          },
          required: ["tray"],
        },
      },
      {
        name: "ams_unload_filament",
        description: "Unload the current filament from the extruder",
        inputSchema: { type: "object", properties: {}, required: [] },
      },

      // --- Camera ---
      {
        name: "camera_record",
        description: "Enable or disable camera recording on the printer",
        inputSchema: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "true to start recording, false to stop",
            },
          },
          required: ["enabled"],
        },
      },
      {
        name: "camera_timelapse",
        description:
          "Enable or disable timelapse recording for the current print",
        inputSchema: {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              description: "true to enable timelapse, false to disable",
            },
          },
          required: ["enabled"],
        },
      },

      {
        name: "camera_snapshot",
        description:
          "Capture a live JPEG snapshot from the printer's chamber camera. " +
          "Connects via TLS to port 6000, authenticates, and grabs a single frame. " +
          "Returns the file path to the saved JPEG image.",
        inputSchema: {
          type: "object",
          properties: {
            host: {
              type: "string",
              description: "Printer IP (defaults to MQTT-connected printer)",
            },
            password: {
              type: "string",
              description: "Printer access code (defaults to MQTT password)",
            },
            output_path: {
              type: "string",
              description:
                "Where to save the JPEG (default: ~/Downloads/printer_snapshot.jpg)",
            },
          },
          required: [],
        },
      },

      // --- Vision Monitor ---
      {
        name: "monitor_start",
        description:
          "Start AI-powered print monitoring. Captures camera snapshots on an interval, " +
          "checks MQTT status for errors, and runs AI vision analysis to detect failures " +
          "(spaghetti, detachment, blobs). Automatically sends emergency stop on failure. " +
          "Works with any Bambu printer that has a camera. " +
          "Requires: MQTT connected + a vision provider configured via env vars " +
          "(AZURE_OPENAI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY).",
        inputSchema: {
          type: "object",
          properties: {
            interval_seconds: {
              type: "number",
              description:
                "Seconds between monitoring cycles (default: 60, min: 10)",
            },
            min_layer: {
              type: "number",
              description:
                "Skip AI vision before this layer number (default: 2). Early layers have too little material to judge.",
            },
            snapshot_dir: {
              type: "string",
              description:
                "Directory to save snapshots (default: ~/Downloads/printer_monitor)",
            },
            fail_strikes: {
              type: "number",
              description:
                "Number of consecutive vision failures required before emergency stop (default: 3). Prevents false positives from single ambiguous frames.",
            },
          },
          required: [],
        },
      },
      {
        name: "monitor_status",
        description:
          "Get the current state of the AI print monitor — cycle count, last verdict, " +
          "print progress, failure status, and any non-fatal errors.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "monitor_stop",
        description:
          "Stop the AI print monitor. Returns a summary of the monitoring session. " +
          "Does NOT stop the print itself — use printer_stop for that.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },

      // --- LED ---
      {
        name: "led_control",
        description: "Control the printer chamber or logo LED lights",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["on", "off"],
              description: "LED state",
            },
            node: {
              type: "string",
              enum: ["chamber_light", "work_light"],
              description: "Which LED to control (default: chamber_light)",
            },
          },
          required: ["mode"],
        },
      },

      // --- Hardware ---
      {
        name: "set_nozzle",
        description: "Set the nozzle diameter (for printing profile selection)",
        inputSchema: {
          type: "object",
          properties: {
            diameter: {
              type: "number",
              description: "Nozzle diameter in mm (e.g., 0.4, 0.6, 0.8)",
            },
          },
          required: ["diameter"],
        },
      },

      // --- Temperature ---
      {
        name: "set_temperature",
        description:
          "Set nozzle or bed temperature via G-code. Validates against safe limits.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["nozzle", "bed"],
              description: "Which heater to set",
            },
            temperature: {
              type: "number",
              description: `Temperature in Celsius (nozzle max: ${SAFE_TEMP_LIMITS.nozzle}, bed max: ${SAFE_TEMP_LIMITS.bed})`,
            },
          },
          required: ["target", "temperature"],
        },
      },

      // --- FTP ---
      {
        name: "ftp_upload_file",
        description:
          "Upload a .gcode, .3mf, or .stl file to the printer SD card via FTPS (port 990). Use printer_print_file to start the print after upload.",
        inputSchema: {
          type: "object",
          properties: {
            host: { type: "string", description: "Printer IP address" },
            local_path: {
              type: "string",
              description: "Path to local file to upload",
            },
            remote_path: {
              type: "string",
              description: "Filename on printer (e.g., model.gcode)",
            },
            password: {
              type: "string",
              description: "LAN access code from printer",
            },
          },
          required: ["host", "local_path", "remote_path", "password"],
        },
      },

      // --- MakerWorld ---
      {
        name: "makerworld_download",
        description:
          "Download a 3MF print file from MakerWorld (makerworld.com). " +
          "Accepts a URL, instance_id, or path to an already-downloaded file. " +
          "When Cloudflare blocks direct access, returns step-by-step instructions " +
          "for browser-assisted download using Firefox DevTools MCP.\n\n" +
          "DEPENDENCY: Firefox DevTools MCP is required for browser-based downloads. " +
          "Install with: npx firefox-devtools-mcp@latest\n" +
          "Add to ~/.claude/user-mcps.json:\n" +
          '  "firefox-devtools": { "command": "npx", "args": ["firefox-devtools-mcp@latest"] }',
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "MakerWorld model URL (e.g., https://makerworld.com/en/models/12345-model-name)",
            },
            instance_id: {
              type: "string",
              description:
                "MakerWorld instance ID for direct download (from __NEXT_DATA__ on the model page: design.instances[].id where isDefault=true)",
            },
            download_path: {
              type: "string",
              description:
                "Path to an already-downloaded 3MF file (skips download, validates and returns file info)",
            },
            cookies: {
              type: "string",
              description:
                "Browser cookies for Cloudflare bypass (extract from Firefox DevTools network request headers)",
            },
            output_dir: {
              type: "string",
              description: "Directory to save the file (default: ~/Downloads)",
            },
          },
          required: [],
        },
      },
      {
        name: "makerworld_print",
        description:
          "Download a model from MakerWorld and print it on the connected printer. " +
          "Combines makerworld_download → ftp_upload → printer_print_file in one step.\n\n" +
          "DEPENDENCY: Firefox DevTools MCP for MakerWorld access. " +
          "Install: npx firefox-devtools-mcp@latest",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "MakerWorld model URL",
            },
            download_path: {
              type: "string",
              description: "Path to already-downloaded 3MF (skips download)",
            },
            instance_id: {
              type: "string",
              description: "MakerWorld instance ID for direct download",
            },
            cookies: {
              type: "string",
              description: "Browser cookies for Cloudflare bypass",
            },
            host: {
              type: "string",
              description:
                "Printer IP (defaults to currently connected MQTT printer)",
            },
            password: {
              type: "string",
              description:
                "Printer access code (defaults to current MQTT password)",
            },
            plate: {
              type: "number",
              description:
                "Plate number for multi-plate 3MF files (1-based, default: 1)",
            },
            ams_mapping: {
              type: "array",
              items: { type: "number" },
              description:
                "AMS slot mapping. Index = color in file, value = AMS slot (0-3) or -1 for external. Default: [0]",
            },
            bed_type: {
              type: "string",
              enum: [
                "auto",
                "cool_plate",
                "engineering_plate",
                "textured_pei_plate",
              ],
              description: "Bed plate type (default: auto)",
            },
            use_ams: {
              type: "boolean",
              description: "Use AMS for filament (default: true)",
            },
            timelapse: {
              type: "boolean",
              description: "Record timelapse (default: false)",
            },
          },
          required: [],
        },
      },
      {
        name: "ams_filament_mapping",
        description:
          "Get the current AMS filament tray mapping — shows which filament " +
          "type and color is loaded in each slot (0-3). Useful for selecting " +
          "the right tray before printing.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "slice_3mf",
        description:
          "Slice a 3MF file using OrcaSlicer CLI. Converts an unsliced 3MF (models + settings) " +
          "into a print-ready 3MF containing gcode. Uses P1S 0.4mm nozzle profiles by default. " +
          "If the file is already sliced, returns it unchanged.\n\n" +
          "REQUIRES: OrcaSlicer installed (brew install --cask orcaslicer)",
        inputSchema: {
          type: "object",
          properties: {
            input_path: {
              type: "string",
              description: "Path to the 3MF file to slice",
            },
            output_path: {
              type: "string",
              description:
                "Output path for sliced file (default: input_sliced.3mf)",
            },
          },
          required: ["input_path"],
        },
      },
    ];
  }

  // ===== Cloud API =====

  private async makeRequest(endpoint: string, options: any = {}) {
    if (!this.config.cookies) {
      throw new Error(
        "Cloud API requires BAMBU_LAB_COOKIES environment variable.",
      );
    }

    const url = `${this.config.baseUrl}${endpoint}`;
    const headers = {
      Cookie: this.config.cookies,
      "Content-Type": "application/json",
      "x-bbl-client-type": "web",
      "x-bbl-client-name": "Portal",
      "x-bbl-client-version": "00.00.00.01",
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      throw new Error(`Cloud API HTTP ${response.status}`);
    }

    return await response.json();
  }

  private async getUserProfile() {
    return ok(await this.makeRequest("/user-service/my/profile"));
  }

  private async listPrinters() {
    try {
      return ok(await this.makeRequest("/user-service/my/devices"));
    } catch (error: any) {
      return ok({
        message: "Cloud device list unavailable",
        suggestion: "Use MQTT for local printer access",
      });
    }
  }

  private async getPrinterStatus(args: { device_id: string }) {
    try {
      return ok(
        await this.makeRequest(
          `/device-service/devices/${args.device_id}/status`,
        ),
      );
    } catch {
      return ok({
        message: "Cloud status unavailable",
        suggestion:
          "Use mqtt_connect + printer_get_status for real-time local status",
        device_id: args.device_id,
      });
    }
  }

  private async signMessage(args: { device_id: string; message: any }) {
    const { message } = args;
    const appCert = getAppCert();

    const messageStr = JSON.stringify(message);
    const signature = crypto
      .sign("RSA-SHA256", Buffer.from(messageStr), appCert.privateKey)
      .toString("base64");

    const signedMessage = {
      ...message,
      header: {
        sign_ver: "v1.0",
        sign_alg: "RSA_SHA256",
        sign_string: signature,
        cert_id: this.config.appCertId,
        payload_len: new TextEncoder().encode(messageStr).length,
      },
    };

    return ok({
      message: "Message signed successfully",
      signed_message: signedMessage,
    });
  }

  // ===== MQTT =====

  private async mqttConnect(args: {
    host: string;
    port?: number;
    username?: string;
    password: string;
    device_id: string;
  }) {
    const config: MQTTConfig = {
      host: args.host,
      port: args.port || 8883,
      username: args.username || "bblp",
      password: args.password,
      deviceId: args.device_id,
    };

    this.mqttClient = new BambuMQTTClient(config);
    await this.mqttClient.connect();

    return ok({
      message: "Connected to printer via MQTT",
      host: args.host,
      device_id: args.device_id,
    });
  }

  private async mqttDisconnect() {
    if (this.mqttClient) {
      this.mqttClient.disconnect();
      this.mqttClient = null;
    }
    return ok({ message: "Disconnected from MQTT" });
  }

  // ===== Print Control =====

  private async printerStop() {
    return ok({
      message: "Print stopped",
      result: await this.requireMQTT().stopPrint(),
    });
  }

  private async printerPause() {
    return ok({
      message: "Print paused",
      result: await this.requireMQTT().pausePrint(),
    });
  }

  private async printerResume() {
    return ok({
      message: "Print resumed",
      result: await this.requireMQTT().resumePrint(),
    });
  }

  private async printerSetSpeed(args: { profile?: string; speed?: number }) {
    const mqtt = this.requireMQTT();

    let speed: number;
    if (args.profile) {
      const profileSpeed = SPEED_PROFILES[args.profile.toLowerCase()];
      if (!profileSpeed) {
        throw new Error(
          `Unknown speed profile. Use: ${Object.keys(SPEED_PROFILES).join(", ")}`,
        );
      }
      speed = profileSpeed;
    } else if (args.speed !== undefined) {
      speed = args.speed;
    } else {
      throw new Error("Provide either a speed profile or a speed percentage");
    }

    if (speed < 1 || speed > 166) {
      throw new Error("Speed must be between 1 and 166");
    }

    const result = await mqtt.setPrintSpeed(speed);
    return ok({
      message: `Speed set to ${speed}%${args.profile ? ` (${args.profile})` : ""}`,
      result,
    });
  }

  private async printerSendGcode(args: { gcode: string }) {
    const validationError = validateGcode(args.gcode);
    if (validationError) throw new Error(validationError);

    const result = await this.requireMQTT().sendGcode(args.gcode);
    return ok({ message: `G-code sent: ${args.gcode}`, result });
  }

  private async printerPrintFile(args: {
    file: string;
    plate?: number;
    ams_mapping?: number[];
    bed_type?: string;
    timelapse?: boolean;
    use_ams?: boolean;
  }) {
    const result = await this.requireMQTT().printFile(args);
    return ok({ message: `Started printing: ${args.file}`, result });
  }

  // ===== Status =====

  private async printerGetStatus() {
    const status = await this.requireMQTT().requestStatus();
    return ok(status);
  }

  private printerGetCachedStatus() {
    const status = this.requireMQTT().getCachedStatus();
    return ok(status);
  }

  private async printerGetVersion() {
    return ok(await this.requireMQTT().getVersion());
  }

  // ===== Object Control =====

  private async skipObjects(args: { object_ids: number[] }) {
    if (!args.object_ids?.length) {
      throw new Error("Provide at least one object ID to skip");
    }
    const result = await this.requireMQTT().skipObjects(args.object_ids);
    return ok({
      message: `Skipping objects: ${args.object_ids.join(", ")}`,
      result,
    });
  }

  // ===== AMS =====

  private async amsChangeFilament(args: {
    tray: number;
    target_temp?: number;
  }) {
    if (args.tray < 0 || args.tray > 3) {
      throw new Error("AMS tray must be between 0 and 3");
    }
    const result = await this.requireMQTT().changeFilament(
      args.tray,
      args.target_temp,
    );
    return ok({ message: `Changing to AMS tray ${args.tray}`, result });
  }

  private async amsUnloadFilament() {
    return ok({
      message: "Unloading filament",
      result: await this.requireMQTT().unloadFilament(),
    });
  }

  // ===== Camera =====

  private async cameraRecord(args: { enabled: boolean }) {
    const result = await this.requireMQTT().setCameraRecording(args.enabled);
    return ok({
      message: `Camera recording ${args.enabled ? "enabled" : "disabled"}`,
      result,
    });
  }

  private async cameraTimelapse(args: { enabled: boolean }) {
    const result = await this.requireMQTT().setTimelapse(args.enabled);
    return ok({
      message: `Timelapse ${args.enabled ? "enabled" : "disabled"}`,
      result,
    });
  }

  private async cameraSnapshot(args: {
    host?: string;
    password?: string;
    output_path?: string;
  }) {
    const host = args.host || MQTT_HOST;
    const password = args.password || MQTT_PASSWORD;

    if (!host || !password) {
      return err(
        "Printer host and access code required. Connect via MQTT first or provide host/password.",
      );
    }

    const outputPath =
      args.output_path ||
      path.join(
        os.homedir(),
        "Downloads",
        `printer_snapshot_${Date.now()}.jpg`,
      );

    const saved = await captureSnapshot(host, password, outputPath);
    const stats = fs.statSync(saved);

    return ok({
      message: "Camera snapshot captured",
      path: saved,
      size_bytes: stats.size,
    });
  }

  // ===== Vision Monitor =====

  private async monitorStart(args: {
    interval_seconds?: number;
    min_layer?: number;
    snapshot_dir?: string;
    fail_strikes?: number;
  }) {
    if (this.printMonitor) {
      const state = this.printMonitor.getState();
      if (state.active) {
        return err(
          "Monitor is already running. Use monitor_stop first, or monitor_status to check progress.",
        );
      }
    }

    const mqtt = this.requireMQTT();

    let visionProvider;
    try {
      visionProvider = createVisionProvider();
    } catch (e: any) {
      return err(e.message);
    }

    const host = MQTT_HOST;
    const accessCode = MQTT_PASSWORD;
    if (!host || !accessCode) {
      return err(
        "Camera requires printer host and access code. Set BAMBU_LAB_MQTT_HOST and BAMBU_LAB_MQTT_PASSWORD.",
      );
    }

    const intervalSeconds = Math.max(args.interval_seconds || 60, 10);
    const snapshotDir =
      args.snapshot_dir ||
      path.join(os.homedir(), "Downloads", "printer_monitor");

    const failStrikes = Math.max(args.fail_strikes || 3, 1);

    this.printMonitor = new PrintMonitor(
      {
        intervalSeconds,
        minLayerForVision: args.min_layer ?? 2,
        failStrikes,
        host,
        accessCode,
        snapshotDir,
      },
      {
        captureSnapshot,
        mqttClient: mqtt,
        visionProvider,
        onLog: (level, message) => {
          console.error(`[monitor] [${level}] ${message}`);
          try {
            this.server.sendLoggingMessage({
              level:
                level === "info"
                  ? "info"
                  : level === "warning"
                    ? "warning"
                    : "error",
              data: message,
            });
          } catch {
            // Logging notification failures are non-fatal
          }
        },
      },
    );

    this.printMonitor.start();

    return ok({
      message: "Print monitor started",
      interval_seconds: intervalSeconds,
      min_layer: args.min_layer ?? 2,
      fail_strikes: failStrikes,
      snapshot_dir: snapshotDir,
      vision_provider: `${visionProvider.name}/${visionProvider.model}`,
    });
  }

  private monitorStatus() {
    if (!this.printMonitor) {
      return ok({
        active: false,
        message: "No monitor running. Use monitor_start to begin monitoring.",
      });
    }
    return ok(this.printMonitor.getState());
  }

  private monitorStop() {
    if (!this.printMonitor) {
      return ok({
        active: false,
        message: "No monitor running.",
      });
    }

    const finalState = this.printMonitor.stop();
    this.printMonitor = null;

    return ok({
      message: "Monitor stopped",
      summary: {
        cycles_completed: finalState.cycleCount,
        failure_detected: finalState.failureDetected,
        failure_reason: finalState.failureReason,
        emergency_stop_sent: finalState.emergencyStopSent,
        last_print_state: finalState.printState,
        last_print_percent: finalState.printPercent,
        errors: finalState.errors,
      },
    });
  }

  // ===== LED =====

  private async ledControl(args: { mode: "on" | "off"; node?: string }) {
    const result = await this.requireMQTT().setLED(args.mode, args.node);
    return ok({
      message: `LED ${args.node || "chamber_light"} ${args.mode}`,
      result,
    });
  }

  // ===== Hardware =====

  private async setNozzle(args: { diameter: number }) {
    const result = await this.requireMQTT().setNozzle(args.diameter);
    return ok({ message: `Nozzle diameter set to ${args.diameter}mm`, result });
  }

  // ===== Temperature =====

  private async setTemperature(args: {
    target: "nozzle" | "bed";
    temperature: number;
  }) {
    const mqtt = this.requireMQTT();
    const { target, temperature } = args;

    const limit =
      target === "nozzle" ? SAFE_TEMP_LIMITS.nozzle : SAFE_TEMP_LIMITS.bed;
    if (temperature < 0 || temperature > limit) {
      throw new Error(`${target} temperature must be between 0 and ${limit}C`);
    }

    // M104 = nozzle, M140 = bed
    const gcode =
      target === "nozzle" ? `M104 S${temperature}` : `M140 S${temperature}`;
    const result = await mqtt.sendGcode(gcode);

    return ok({
      message: `${target} temperature set to ${temperature}C`,
      gcode,
      result,
    });
  }

  // ===== FTP =====

  /**
   * Upload via curl FTPS (reliable fallback for P1S which has basic-ftp timeout issues)
   */
  private async ftpUploadViaCurl(args: {
    host: string;
    local_path: string;
    remote_path: string;
    password: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const ftpsUrl = `ftps://bblp:${args.password}@${args.host}:990/${args.remote_path}`;
      execFile(
        "curl",
        ["--ftp-ssl-reqd", "--insecure", "-T", args.local_path, ftpsUrl],
        { timeout: 60000 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(
              new Error(`curl FTPS upload failed: ${stderr || error.message}`),
            );
          } else {
            resolve();
          }
        },
      );
    });
  }

  private async ftpUploadFile(args: {
    host: string;
    local_path: string;
    remote_path: string;
    password: string;
  }) {
    const pathError = validateFTPPath(args.local_path);
    if (pathError) throw new Error(pathError);

    const remoteError = validateRemotePath(args.remote_path);
    if (remoteError) throw new Error(remoteError);

    // Try basic-ftp first, fall back to curl on timeout
    try {
      const ftp = new FTPClient();
      ftp.ftp.verbose = false;

      await ftp.access({
        host: args.host,
        port: 990,
        user: "bblp",
        password: args.password,
        secure: true,
        secureOptions: { rejectUnauthorized: false },
      });

      await ftp.uploadFrom(args.local_path, args.remote_path);
      ftp.close();
    } catch (ftpError: any) {
      console.error(
        `basic-ftp failed (${ftpError.message}), falling back to curl`,
      );
      await this.ftpUploadViaCurl(args);
    }

    return ok({
      message: "File uploaded successfully",
      local: args.local_path,
      remote: args.remote_path,
      next_step: `Use printer_print_file with file="${args.remote_path}" to print`,
    });
  }

  // ===== MakerWorld =====

  private async makerWorldDownload(args: {
    url?: string;
    instance_id?: string;
    download_path?: string;
    cookies?: string;
    output_dir?: string;
  }) {
    const result = await makerWorldDownload(args);
    return ok(result);
  }

  private async makerWorldPrint(args: {
    url?: string;
    download_path?: string;
    instance_id?: string;
    cookies?: string;
    host?: string;
    password?: string;
    bed_type?: string;
    use_ams?: boolean;
    ams_mapping?: number[];
    plate?: number;
    timelapse?: boolean;
  }) {
    // Step 1: Get the file
    const dlResult = await makerWorldDownload({
      url: args.url,
      instance_id: args.instance_id,
      download_path: args.download_path,
      cookies: args.cookies,
    });

    // If we got browser workflow instructions, return them
    if (dlResult.steps) {
      return ok({
        ...dlResult,
        message:
          "Download requires browser assistance. Complete the download steps, then call makerworld_print again with download_path.",
      });
    }

    const filePath = dlResult.path;
    if (!filePath) {
      return err("No file path in download result", JSON.stringify(dlResult));
    }

    // Step 2: Slice if needed (MakerWorld 3MFs are unsliced — no gcode inside)
    let slicedPath: string;
    try {
      slicedPath = await slice3mf(filePath);
    } catch (sliceErr: any) {
      return err(
        `Slicing failed: ${sliceErr.message}`,
        "Install OrcaSlicer (brew install --cask orcaslicer) for automatic slicing.",
      );
    }

    // Step 3: Get printer connection info
    const mqtt = this.requireMQTT();
    const host = args.host || MQTT_HOST || mqtt["config"]?.host;
    const password = args.password || MQTT_PASSWORD || mqtt["config"]?.password;

    if (!host || !password) {
      return err(
        "Printer host and password required for FTP upload. Connect via MQTT first or provide host/password.",
      );
    }

    // Step 4: Upload sliced file via FTP
    const remoteName = path.basename(slicedPath);
    const uploadResult = await this.ftpUploadFile({
      host,
      local_path: slicedPath,
      remote_path: remoteName,
      password,
    });

    // Step 5: Start printing
    const printResult = await this.printerPrintFile({
      file: remoteName,
      plate: args.plate,
      ams_mapping: args.ams_mapping,
      bed_type: args.bed_type,
      use_ams: args.use_ams,
      timelapse: args.timelapse,
    });

    return ok({
      message: `Printing ${remoteName} from MakerWorld`,
      download: dlResult,
      sliced: slicedPath !== filePath ? slicedPath : "already sliced",
      upload: uploadResult,
      print: printResult,
    });
  }

  // ===== Slicer Tool =====

  private async slice3mfTool(args: {
    input_path: string;
    output_path?: string;
  }) {
    const resolved = path.resolve(args.input_path);
    if (!fs.existsSync(resolved)) {
      return err(`File not found: ${resolved}`);
    }

    const alreadySliced = is3mfSliced(resolved);
    if (alreadySliced) {
      return ok({
        message: "File is already sliced (contains gcode)",
        path: resolved,
        sliced: false,
      });
    }

    const output = await slice3mf(resolved, args.output_path);
    return ok({
      message: "File sliced successfully",
      input: resolved,
      output,
      sliced: true,
    });
  }

  // ===== AMS Filament Mapping =====

  private amsFilamentMapping() {
    const mqtt = this.requireMQTT();
    const status = mqtt.getCachedStatus();
    const ams = status?.ams;

    if (!ams?.ams?.length) {
      return ok({
        message:
          "No AMS data available. Request a status update first with printer_get_status.",
        suggestion:
          "Call printer_get_status to refresh AMS data, then try again.",
      });
    }

    const mapping = ams.ams.flatMap((unit: any) => {
      const unitId = unit.id;
      const trays = (unit.tray || []).map((tray: any) => {
        const color = tray.tray_color ? `#${tray.tray_color}` : "unknown";
        return {
          unit: parseInt(unitId),
          slot: parseInt(tray.id),
          global_slot: parseInt(unitId) * 4 + parseInt(tray.id),
          filament_type: tray.tray_type || "empty",
          color,
          color_hex: tray.tray_color || null,
          remaining_percent: tray.remain ?? null,
          tray_sub_brands: tray.tray_sub_brands || null,
        };
      });
      return trays;
    });

    return ok({
      message: "AMS filament tray mapping",
      current_tray: ams.tray_now,
      trays: mapping,
    });
  }

  // ===== Server Lifecycle =====

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("=".repeat(50));
    console.error("Bambu Lab MCP Server v3.1.0");
    console.error("=".repeat(50));
    console.error(
      "Cloud:",
      this.config.cookies ? "configured" : "not configured",
    );
    console.error(
      "MQTT:",
      this.mqttClient?.isConnected() ? "connected" : "not connected",
    );
    console.error("=".repeat(50));
  }
}

const mcp = new BambuLabMCP();
mcp.run().catch(console.error);
