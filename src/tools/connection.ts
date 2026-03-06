import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolModule } from "./tool-module.js";
import type { ToolContext } from "../tool-context.js";
import { ok } from "../tool-context.js";
import { BambuMQTTClient, type MQTTConfig } from "../mqtt-client.js";
import { getAppCert } from "../types.js";

export const tools: Tool[] = [
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
];

export function createHandlers(
  ctx: ToolContext,
): Record<string, (args: any) => Promise<any>> {
  return {
    mqtt_connect: async (args: {
      host: string;
      port?: number;
      username?: string;
      password: string;
      device_id: string;
    }) => {
      const appCert = getAppCert();
      const config: MQTTConfig = {
        host: args.host,
        port: args.port || 8883,
        username: args.username || "bblp",
        password: args.password,
        deviceId: args.device_id,
        privateKey: appCert.privateKey,
        certId: ctx.config.appCertId,
        userId: ctx.getEnv("BAMBU_LAB_USER_ID") || undefined,
      };

      const client = new BambuMQTTClient(config);
      await client.connect();
      ctx.setMqttClient(client);

      return ok({
        message: "Connected to printer via MQTT (commands signed)",
        host: args.host,
        device_id: args.device_id,
      });
    },

    mqtt_disconnect: async () => {
      const client = ctx.getMqttClient();
      if (client) {
        client.disconnect();
        ctx.setMqttClient(null);
      }
      return ok({ message: "Disconnected from MQTT" });
    },
  };
}

const connectionModule: ToolModule = { tools, createHandlers };
export default connectionModule;
