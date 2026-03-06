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
 * - Write protection for dangerous operations
 * - Output redaction for sensitive values
 * - MCP resources for printer status and knowledge
 *
 * Protocol reference: https://github.com/Doridian/OpenBambuAPI
 * X.509 background: https://hackaday.com/2025/01/19/bambu-connects-authentication-x-509-certificate-and-private-key-extracted/
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAppCert, type BambuLabConfig } from "./types.js";
import { BambuMQTTClient, type MQTTConfig } from "./mqtt-client.js";
import type { PrintMonitor } from "./print-monitor.js";
import type { ToolContext } from "./tool-context.js";
import { err } from "./tool-context.js";
import { initRedaction, registerSensitiveValue } from "./redact.js";
import { addConfirmParam, checkConfirmation } from "./write-protection.js";
import { getResources, readResource } from "./resources.js";
import { getSecret } from "./secrets.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Tool modules
import cloudApiModule from "./tools/cloud-api.js";
import connectionModule from "./tools/connection.js";
import printControlModule from "./tools/print-control.js";
import statusModule from "./tools/status.js";
import amsModule from "./tools/ams.js";
import cameraModule from "./tools/camera.js";
import monitorModule from "./tools/monitor.js";
import hardwareModule from "./tools/hardware.js";
import filesModule from "./tools/files.js";
import makerWorldModule from "./tools/makerworld-tools.js";
import slicerModule from "./tools/slicer.js";

// Initialize redaction with known sensitive env vars
initRedaction();

// Credentials file (auto-populated by `npm run setup`)
interface SavedCredentials {
  accessToken?: string;
  userId?: string;
  printer?: { deviceId?: string; accessCode?: string; host?: string };
}

function loadCredentialsFile(): SavedCredentials {
  try {
    const credsPath = path.join(os.homedir(), ".bambu-mcp", "credentials.json");
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
      console.error("[bambu-mcp] Loaded credentials from", credsPath);
      return creds;
    }
  } catch (e: any) {
    console.error("[bambu-mcp] Failed to load credentials file:", e.message);
  }
  return {};
}

const savedCreds = loadCredentialsFile();

// Configuration (env vars > encrypted secrets > credentials file)
const BASE_URL =
  getSecret("BAMBU_LAB_BASE_URL") || "https://api.bambulab.com/v1";
const AUTH_COOKIES = getSecret("BAMBU_LAB_COOKIES") || "";
const ACCESS_TOKEN =
  getSecret("BAMBU_LAB_ACCESS_TOKEN") || savedCreds.accessToken || "";
const APP_CERT_ID =
  getSecret("BAMBU_LAB_APP_CERT_ID") ||
  "GLOF3813734089-524a37c80000c6a6a274a47b3281";

const MQTT_HOST =
  getSecret("BAMBU_LAB_MQTT_HOST") || savedCreds.printer?.host || "";
const MQTT_PORT = parseInt(getSecret("BAMBU_LAB_MQTT_PORT") || "8883");
const MQTT_USERNAME = getSecret("BAMBU_LAB_MQTT_USERNAME") || "bblp";
const MQTT_PASSWORD =
  getSecret("BAMBU_LAB_MQTT_PASSWORD") || savedCreds.printer?.accessCode || "";
const MQTT_DEVICE_ID =
  getSecret("BAMBU_LAB_DEVICE_ID") || savedCreds.printer?.deviceId || "";
const USER_ID = getSecret("BAMBU_LAB_USER_ID") || savedCreds.userId || "";

// Register dynamically-loaded secrets for redaction
if (AUTH_COOKIES) registerSensitiveValue(AUTH_COOKIES);
if (ACCESS_TOKEN) registerSensitiveValue(ACCESS_TOKEN);
if (MQTT_PASSWORD) registerSensitiveValue(MQTT_PASSWORD);
if (MQTT_HOST) registerSensitiveValue(MQTT_HOST);
if (MQTT_DEVICE_ID) registerSensitiveValue(MQTT_DEVICE_ID);

// All tool modules
const toolModules = [
  cloudApiModule,
  connectionModule,
  printControlModule,
  statusModule,
  amsModule,
  cameraModule,
  monitorModule,
  hardwareModule,
  filesModule,
  makerWorldModule,
  slicerModule,
];

class BambuLabMCP {
  private config: BambuLabConfig;
  private server: Server;
  private mqttClient: BambuMQTTClient | null = null;
  private printMonitor: PrintMonitor | null = null;
  private handlers: Record<string, (args: any) => Promise<any>> = {};

  constructor() {
    this.config = {
      baseUrl: BASE_URL,
      cookies: AUTH_COOKIES,
      appCertId: APP_CERT_ID,
    };

    this.server = new Server(
      { name: "bambu-lab-mcp", version: "3.2.0" },
      { capabilities: { tools: {}, resources: {}, logging: {} } },
    );

    const ctx = this.createContext();

    // Collect handlers from all modules
    for (const mod of toolModules) {
      Object.assign(this.handlers, mod.createHandlers(ctx));
    }

    this.setupHandlers();
    this.initMQTT();
  }

  private createContext(): ToolContext {
    return {
      config: this.config,
      getMqttClient: () => this.mqttClient,
      setMqttClient: (client) => {
        this.mqttClient = client;
      },
      requireMQTT: () => {
        if (!this.mqttClient || !this.mqttClient.isConnected()) {
          throw new Error("MQTT not connected. Use mqtt_connect first.");
        }
        return this.mqttClient;
      },
      getMonitor: () => this.printMonitor,
      setMonitor: (monitor) => {
        this.printMonitor = monitor;
      },
      getServer: () => this.server,
      getEnv: (key: string) => getSecret(key) || "",
    };
  }

  private async initMQTT() {
    if (MQTT_HOST && MQTT_PASSWORD && MQTT_DEVICE_ID) {
      try {
        const appCert = getAppCert();
        const config: MQTTConfig = {
          host: MQTT_HOST,
          port: MQTT_PORT,
          username: MQTT_USERNAME,
          password: MQTT_PASSWORD,
          deviceId: MQTT_DEVICE_ID,
          privateKey: appCert.privateKey,
          certId: APP_CERT_ID,
          userId: USER_ID || undefined,
        };

        this.mqttClient = new BambuMQTTClient(config);
        await this.mqttClient.connect();
        console.error(
          "[bambu-mcp] MQTT connected to",
          MQTT_HOST,
          "(commands signed)",
        );
      } catch (error: any) {
        console.error("[bambu-mcp] MQTT connection failed:", error.message);
      }
    } else {
      console.error(
        "[bambu-mcp] MQTT not configured — set BAMBU_LAB_MQTT_HOST, BAMBU_LAB_MQTT_PASSWORD, BAMBU_LAB_DEVICE_ID",
      );
    }
  }

  private setupHandlers() {
    // Collect all tools with write-protection params injected
    const allTools = toolModules.flatMap((m) => m.tools.map(addConfirmParam));

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allTools,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        // Write protection check
        const warning = checkConfirmation(name, args);
        if (warning) {
          return err(warning);
        }

        const handler = this.handlers[name];
        if (!handler) {
          return err(`Unknown tool: ${name}`);
        }
        return await handler(args as any);
      } catch (error: any) {
        console.error(`[bambu-mcp] Tool ${name} failed:`, error.message);
        return err(error.message);
      }
    });

    // Resources
    const ctx = this.createContext();

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: getResources(),
    }));

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const { uri } = request.params;
        try {
          const content = readResource(uri, ctx);
          return {
            contents: [{ uri, mimeType: "application/json", text: content }],
          };
        } catch (error: any) {
          throw new Error(`Resource read failed: ${error.message}`);
        }
      },
    );
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("=".repeat(50));
    console.error("Bambu Lab MCP Server v3.2.0");
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
