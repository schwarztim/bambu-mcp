/**
 * MakerWorld Integration
 *
 * Downloads 3MF/STL files from MakerWorld (makerworld.com) for printing.
 *
 * MakerWorld is protected by Cloudflare, so direct API access is typically
 * blocked. This module supports two download paths:
 *   1. Direct API (works if cookies are provided from a browser session)
 *   2. Browser-assisted (AI uses Firefox DevTools MCP to navigate and download)
 *
 * API reference (reverse-engineered from community extensions):
 *   - Model page data: embedded in __NEXT_DATA__ script tag
 *   - Design API: /api/v1/design-service/design/{modelId}
 *   - Download API: /api/v1/design-service/instance/{instanceId}/f3mf?type=download
 *   - Instance ID: design.instances.find(i => i.isDefault).id
 */

import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ===== Constants =====

const MAKERWORLD_DOMAINS = ["makerworld.com", "makerworld.com.cn"];
const API_BASE = "/api/v1/design-service";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0";

// ===== Types =====

export interface MakerWorldModelInfo {
  modelId: string;
  profileId?: string;
  slug?: string;
  domain: string;
  lang: string;
  url: string;
}

export interface MakerWorldInstance {
  id: number;
  isDefault?: boolean;
  title?: string;
  [key: string]: any;
}

export interface MakerWorldDesign {
  id: number;
  title?: string;
  designCreator?: { name?: string };
  instances?: MakerWorldInstance[];
  [key: string]: any;
}

// ===== URL Parsing =====

/**
 * Parse a MakerWorld URL to extract model ID and profile ID.
 *
 * Supports:
 *   https://makerworld.com/en/models/2344501-printable-snap-lock-keyring
 *   https://makerworld.com/en/models/2344501#profileId-2563198
 *   https://makerworld.com.cn/zh/models/12345
 */
export function parseMakerWorldUrl(url: string): MakerWorldModelInfo | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (!MAKERWORLD_DOMAINS.includes(host)) {
      return null;
    }

    const modelMatch = parsed.pathname.match(
      /\/(en|zh)\/models\/(\d+)(?:-([^/]*))?/,
    );
    if (!modelMatch) return null;

    const [, lang, modelId, slug] = modelMatch;

    let profileId: string | undefined;
    const hashMatch = parsed.hash.match(/profileId-(\d+)/);
    if (hashMatch) {
      profileId = hashMatch[1];
    }

    return {
      modelId,
      profileId,
      slug: slug || undefined,
      domain: `https://${host}`,
      lang,
      url,
    };
  } catch {
    return null;
  }
}

// ===== API URL Builders =====

export function buildModelApiUrl(
  domain: string,
  modelId: string | number,
): string {
  return `${domain}${API_BASE}/design/${modelId}`;
}

export function buildDownloadUrl(
  domain: string,
  instanceId: string | number,
): string {
  return `${domain}${API_BASE}/instance/${instanceId}/f3mf?type=download`;
}

// ===== Data Extraction =====

/**
 * Extract design data from __NEXT_DATA__ JSON (the script tag on model pages).
 */
export function extractDesignFromNextData(
  json: string,
): MakerWorldDesign | null {
  try {
    const data = JSON.parse(json);
    return data?.props?.pageProps?.design || null;
  } catch {
    return null;
  }
}

/**
 * Get the default instance ID from a design object.
 */
export function getDefaultInstanceId(design: MakerWorldDesign): number | null {
  if (!design?.instances?.length) return null;
  const def = design.instances.find((i) => i.isDefault);
  return def?.id ?? design.instances[0]?.id ?? null;
}

// ===== HTTP Helpers =====

/**
 * Attempt to fetch a URL with browser-like headers.
 * Returns null body if Cloudflare blocks the request.
 */
export async function fetchBrowserLike(
  url: string,
  cookies?: string,
): Promise<{
  ok: boolean;
  status: number;
  body: string | null;
  cloudflareBlocked: boolean;
}> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/json,*/*",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (cookies) headers["Cookie"] = cookies;

    const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();

    const blocked =
      response.status === 403 ||
      body.includes("Verify you are human") ||
      body.includes("cf-turnstile") ||
      body.includes("challenges.cloudflare.com");

    return {
      ok: response.ok && !blocked,
      status: response.status,
      body: blocked ? null : body,
      cloudflareBlocked: blocked,
    };
  } catch (error: any) {
    return { ok: false, status: 0, body: null, cloudflareBlocked: false };
  }
}

/**
 * Download a file to disk. Returns the written path and byte count.
 */
export async function downloadFileToDisk(
  url: string,
  outputPath: string,
  cookies?: string,
): Promise<{ success: boolean; path?: string; size?: number; error?: string }> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
    };
    if (cookies) headers["Cookie"] = cookies;

    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, buffer);

    return { success: true, path: outputPath, size: buffer.length };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ===== File Discovery =====

/**
 * Find the most recently downloaded 3MF file (within maxAgeSeconds).
 */
export function findRecent3mf(
  directory?: string,
  maxAgeSeconds = 300,
): string | null {
  const dir = directory || path.join(os.homedir(), "Downloads");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".3mf"))
      .map((f) => {
        const full = path.join(dir, f);
        return { name: f, path: full, mtime: fs.statSync(full).mtime };
      })
      .filter((f) => (Date.now() - f.mtime.getTime()) / 1000 < maxAgeSeconds)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return files[0]?.path || null;
  } catch {
    return null;
  }
}

// ===== Orchestration =====

/**
 * Browser-assisted download workflow instructions.
 * Returns step-by-step guidance for the AI to follow with Firefox DevTools.
 */
export function getBrowserWorkflow(info: MakerWorldModelInfo) {
  return {
    message:
      "Cloudflare blocked direct access. Use Firefox DevTools MCP to download.",
    dependency:
      "firefox-devtools MCP — install: npx firefox-devtools-mcp@latest",
    steps: [
      {
        step: 1,
        action: "navigate",
        description: "Navigate Firefox to the MakerWorld model page",
        url: info.url,
        tool: "mcp__firefox-devtools__navigate_page",
      },
      {
        step: 2,
        action: "wait",
        description:
          "Wait 3-5 seconds for the page to fully load and pass Cloudflare",
      },
      {
        step: 3,
        action: "find_download",
        description:
          "Take a snapshot and find the download dropdown button (next to 'Open in Bambu Studio'). Click it to reveal 3MF and STL download options.",
        css_hint: "div.sub_download, div.mw-css-shmjb5",
        tool: "mcp__firefox-devtools__take_snapshot + mcp__firefox-devtools__click_by_uid",
      },
      {
        step: 4,
        action: "click_3mf",
        description:
          "Click the '3MF' download option in the dropdown. The file will download to ~/Downloads.",
      },
      {
        step: 5,
        action: "pickup",
        description:
          "Call makerworld_download again with download_path pointing to the downloaded .3mf file in ~/Downloads",
        tool: "makerworld_download",
      },
    ],
    model_info: info,
    api_endpoints: {
      model_details: buildModelApiUrl(info.domain, info.modelId),
      download_template: `${info.domain}${API_BASE}/instance/{INSTANCE_ID}/f3mf?type=download`,
    },
  };
}

/**
 * Main download orchestrator.
 *
 * Priority:
 *   1. If download_path provided → validate and return it
 *   2. If instance_id provided → try direct download
 *   3. Try to fetch model page and auto-resolve instance ID
 *   4. Fall back to browser workflow instructions
 */
export async function makerWorldDownload(args: {
  url?: string;
  instance_id?: string;
  download_path?: string;
  cookies?: string;
  output_dir?: string;
}): Promise<any> {
  // Path 1: Already-downloaded file
  if (args.download_path) {
    const p = path.resolve(args.download_path);
    if (!fs.existsSync(p)) {
      throw new Error(`File not found: ${p}`);
    }
    const stat = fs.statSync(p);
    return {
      message: "File ready for upload",
      path: p,
      filename: path.basename(p),
      size_bytes: stat.size,
      size_mb: (stat.size / 1024 / 1024).toFixed(2),
    };
  }

  // Need a URL for the remaining paths
  if (!args.url && !args.instance_id) {
    throw new Error("Provide a MakerWorld URL, instance_id, or download_path");
  }

  const info = args.url ? parseMakerWorldUrl(args.url) : null;
  const domain = info?.domain || "https://makerworld.com";
  const outDir = args.output_dir || path.join(os.homedir(), "Downloads");

  // Path 2: Direct download with known instance ID
  if (args.instance_id) {
    const dlUrl = buildDownloadUrl(domain, args.instance_id);
    const outPath = path.join(outDir, `makerworld_${args.instance_id}.3mf`);
    const result = await downloadFileToDisk(dlUrl, outPath, args.cookies);
    if (result.success) {
      return {
        message: "Downloaded successfully",
        ...result,
        instance_id: args.instance_id,
      };
    }
    // If direct download failed but we have URL info, fall through to browser workflow
    if (info) {
      return {
        ...getBrowserWorkflow(info),
        direct_download_error: result.error,
      };
    }
    throw new Error(`Download failed: ${result.error}`);
  }

  // Path 3: Try to auto-resolve from URL
  if (!info) {
    throw new Error("Invalid MakerWorld URL");
  }

  // Try fetching model page directly
  const pageResult = await fetchBrowserLike(info.url, args.cookies);

  if (pageResult.ok && pageResult.body) {
    // Try to extract __NEXT_DATA__
    const nextDataMatch = pageResult.body.match(
      /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (nextDataMatch) {
      const design = extractDesignFromNextData(nextDataMatch[1]);
      if (design) {
        const instanceId = getDefaultInstanceId(design);
        if (instanceId) {
          const dlUrl = buildDownloadUrl(info.domain, instanceId);
          const filename = `${design.title || info.modelId}.3mf`
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .replace(/_+/g, "_");
          const outPath = path.join(outDir, filename);

          const result = await downloadFileToDisk(dlUrl, outPath, args.cookies);
          if (result.success) {
            return {
              message: "Downloaded successfully",
              ...result,
              model_id: info.modelId,
              instance_id: instanceId,
              title: design.title,
            };
          }
        }
      }
    }
  }

  // Path 4: Browser workflow fallback
  return getBrowserWorkflow(info);
}
