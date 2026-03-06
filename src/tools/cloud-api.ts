import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolModule } from "./tool-module.js";
import type { ToolContext } from "../tool-context.js";
import { ok } from "../tool-context.js";
import fetch from "node-fetch";
import * as crypto from "crypto";
import { getAppCert } from "../types.js";
import { getSecret } from "../secrets.js";

export const tools: Tool[] = [
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
    description: "Get printer status via cloud API (requires cloud cookies)",
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
];

async function makeRequest(
  ctx: ToolContext,
  endpoint: string,
  options: any = {},
) {
  const accessToken = getSecret("BAMBU_LAB_ACCESS_TOKEN") || "";
  if (!accessToken && !ctx.config.cookies) {
    throw new Error(
      "Cloud API requires authentication. Run `npm run setup` or set BAMBU_LAB_ACCESS_TOKEN.",
    );
  }

  const url = `${ctx.config.baseUrl}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-bbl-client-type": "web",
    "x-bbl-client-name": "Portal",
    "x-bbl-client-version": "00.00.00.01",
    ...options.headers,
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  } else if (ctx.config.cookies) {
    headers["Cookie"] = ctx.config.cookies;
  }

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    throw new Error(`Cloud API HTTP ${response.status}`);
  }

  return await response.json();
}

export function createHandlers(
  ctx: ToolContext,
): Record<string, (args: any) => Promise<any>> {
  return {
    get_user_profile: async () => {
      return ok(await makeRequest(ctx, "/user-service/my/profile"));
    },

    list_printers: async () => {
      try {
        return ok(await makeRequest(ctx, "/user-service/my/devices"));
      } catch {
        return ok({
          message: "Cloud device list unavailable",
          suggestion: "Use MQTT for local printer access",
        });
      }
    },

    get_printer_status: async (args: { device_id: string }) => {
      try {
        return ok(
          await makeRequest(
            ctx,
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
    },

    sign_message: async (args: { device_id: string; message: any }) => {
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
          cert_id: ctx.config.appCertId,
          payload_len: new TextEncoder().encode(messageStr).length,
        },
      };

      return ok({
        message: "Message signed successfully",
        signed_message: signedMessage,
      });
    },
  };
}

const cloudApiModule: ToolModule = { tools, createHandlers };
export default cloudApiModule;
