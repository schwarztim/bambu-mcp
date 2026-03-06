#!/usr/bin/env node
/**
 * Bambu Lab MCP — Interactive Setup
 *
 * Opens bambulab.com login in Firefox (avoids Google SSO bot detection on Chrome),
 * captures the JWT access token, auto-discovers printers, and saves credentials
 * to ~/.bambu-mcp/credentials.json + optionally macOS Keychain.
 *
 * Usage: npm run setup
 */

import { firefox } from "playwright";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { createInterface } from "readline";

const CREDS_DIR = join(homedir(), ".bambu-mcp");
const CREDS_FILE = join(CREDS_DIR, "credentials.json");
const API_BASE = "https://api.bambulab.com/v1";
const LOGIN_URL = "https://bambulab.com/en/sign-in";

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(question) {
  return new Promise((resolve) => {
    const r = rl();
    r.question(question, (answer) => {
      r.close();
      resolve(answer.trim());
    });
  });
}

async function apiGet(endpoint, token) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`);
  return res.json();
}

function keychainSet(key, value) {
  try {
    execSync(
      `security add-generic-password -s "bambu-lab-mcp" -a "${key}" -w "${value}" -U`,
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

function loadExisting() {
  try {
    if (existsSync(CREDS_FILE)) {
      return JSON.parse(readFileSync(CREDS_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

async function captureToken() {
  console.log("\n🔑 Opening Bambu Lab login in Firefox...");
  console.log("   (Firefox is used to avoid Google SSO bot detection on Chrome)\n");

  let browser;
  try {
    browser = await firefox.launch({ headless: false });
  } catch (e) {
    if (e.message?.includes("Executable doesn't exist")) {
      console.log("Firefox not installed for Playwright. Installing...\n");
      execSync("npx playwright install firefox", { stdio: "inherit" });
      browser = await firefox.launch({ headless: false });
    } else {
      throw e;
    }
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  let accessToken = null;

  // Intercept API responses to capture the token
  page.on("response", async (response) => {
    const url = response.url();
    // Capture token from login response
    if (url.includes("/user-service/user/login") && response.status() === 200) {
      try {
        const body = await response.json();
        if (body.accessToken) {
          accessToken = body.accessToken;
          console.log("✅ Captured access token from login response");
        }
      } catch {}
    }
  });

  // Also watch for token in cookies (bambulab.com sets it as 'token' cookie)
  context.on("page", () => {});

  await page.goto(LOGIN_URL);

  console.log("👉 Please log in to your Bambu Lab account in the browser window.");
  console.log("   Waiting for successful login...\n");

  // Wait for redirect after login (lands on /en or /en/dashboard)
  // or for the token to be captured
  const maxWait = 300_000; // 5 minutes
  const start = Date.now();

  while (!accessToken && Date.now() - start < maxWait) {
    // Check cookies as fallback
    const cookies = await context.cookies("https://bambulab.com");
    const tokenCookie = cookies.find((c) => c.name === "token");
    if (tokenCookie?.value) {
      accessToken = tokenCookie.value;
      console.log("✅ Captured access token from cookie");
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await browser.close();

  if (!accessToken) {
    console.error("❌ Login timed out or token not captured. Try again.");
    process.exit(1);
  }

  return accessToken;
}

async function discoverPrinters(token) {
  console.log("\n📡 Discovering your account and printers...\n");

  // Get user ID
  const prefs = await apiGet("/design-user-service/my/preference", token);
  const userId = String(prefs.uid);
  const userName = prefs.name || prefs.handle || "unknown";
  console.log(`   User: ${userName} (ID: ${userId})`);

  // Get bound printers
  const bindResult = await apiGet("/iot-service/api/user/bind", token);
  const devices = bindResult.devices || [];

  if (devices.length === 0) {
    console.log("   ⚠️  No printers found on your account.");
    return { userId, userName, devices: [] };
  }

  console.log(`   Found ${devices.length} printer(s):\n`);
  devices.forEach((d, i) => {
    console.log(
      `   [${i}] ${d.name} (${d.dev_product_name}) — ${d.online ? "online" : "offline"} — ${d.dev_id}`,
    );
  });

  return { userId, userName, devices };
}

async function selectPrinter(devices) {
  if (devices.length === 0) return null;
  if (devices.length === 1) {
    console.log(`\n   Auto-selecting your only printer: ${devices[0].name}`);
    return devices[0];
  }

  const choice = await ask(`\n   Which printer? [0-${devices.length - 1}]: `);
  const idx = parseInt(choice);
  if (isNaN(idx) || idx < 0 || idx >= devices.length) {
    console.error("Invalid selection.");
    process.exit(1);
  }
  return devices[idx];
}

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Bambu Lab MCP — Interactive Setup  ║");
  console.log("╚══════════════════════════════════════╝");

  // Check for existing credentials
  const existing = loadExisting();
  if (existing?.accessToken) {
    console.log(`\nExisting credentials found (${CREDS_FILE})`);
    if (existing.printer?.name) {
      console.log(`Printer: ${existing.printer.name} (${existing.printer.deviceId})`);
    }
    const redo = await ask("Re-authenticate? [y/N]: ");
    if (redo.toLowerCase() !== "y") {
      console.log("Keeping existing credentials. Done.");
      process.exit(0);
    }
  }

  // Step 1: Browser login
  const accessToken = await captureToken();

  // Step 2: Discover printers
  const { userId, userName, devices } = await discoverPrinters(accessToken);
  const printer = await selectPrinter(devices);

  // Step 3: Get printer IP (ask user — not available from cloud API)
  let printerIp = "";
  if (printer) {
    console.log(
      `\n   The printer's LAN IP is needed for MQTT control.`,
    );
    console.log(
      `   Find it on the printer: Screen → WLAN → IP Address`,
    );
    printerIp = await ask("   Printer IP address: ");
  }

  // Step 4: Build credentials
  const credentials = {
    accessToken,
    userId,
    userName,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // ~3 months
    createdAt: new Date().toISOString(),
    printer: printer
      ? {
          name: printer.name,
          deviceId: printer.dev_id,
          model: printer.dev_product_name,
          accessCode: printer.dev_access_code?.trim() || "",
          host: printerIp,
        }
      : null,
  };

  // Step 5: Save
  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(CREDS_FILE, JSON.stringify(credentials, null, 2));
  console.log(`\n💾 Saved credentials to ${CREDS_FILE}`);

  // Step 6: Optionally save to macOS Keychain
  if (process.platform === "darwin") {
    const useKeychain = await ask("Save to macOS Keychain too? [Y/n]: ");
    if (useKeychain.toLowerCase() !== "n") {
      let ok = 0;
      if (printer) {
        ok += keychainSet("mqtt-host", printerIp);
        ok += keychainSet("mqtt-password", credentials.printer.accessCode);
        ok += keychainSet("device-id", printer.dev_id);
      }
      ok += keychainSet("access-token", accessToken);
      ok += keychainSet("user-id", userId);
      console.log(`🔐 Saved ${ok} items to Keychain (service: bambu-lab-mcp)`);
    }
  }

  // Step 7: Print summary
  console.log("\n✅ Setup complete!\n");

  if (printer) {
    console.log("Environment variables (if you prefer env vars over credentials file):\n");
    console.log(`  BAMBU_LAB_MQTT_HOST=${printerIp}`);
    console.log(`  BAMBU_LAB_MQTT_PASSWORD=${credentials.printer.accessCode}`);
    console.log(`  BAMBU_LAB_DEVICE_ID=${printer.dev_id}`);
    console.log(`  BAMBU_LAB_USER_ID=${userId}`);
    console.log(`  BAMBU_LAB_ACCESS_TOKEN=${accessToken.substring(0, 20)}...`);
  }

  console.log(
    "\nThe MCP will auto-load credentials from ~/.bambu-mcp/credentials.json",
  );
  console.log("Token is valid for ~3 months. Run `npm run setup` again to refresh.\n");
}

main().catch((e) => {
  console.error("Setup failed:", e.message);
  process.exit(1);
});
