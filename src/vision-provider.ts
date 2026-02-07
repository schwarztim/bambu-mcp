/**
 * AI Vision Provider Abstraction
 *
 * Supports Azure OpenAI, OpenAI, and Anthropic for analyzing
 * camera snapshots to detect print failures (spaghetti, detachment, etc.).
 *
 * Provider is selected via VISION_PROVIDER env var, or auto-detected
 * from whichever API key is present.
 */

import fetch from "node-fetch";

export interface VisionAnalysisResult {
  failed: boolean;
  reason: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface VisionProvider {
  name: string;
  model: string;
  analyze(imageBase64: string, prompt: string): Promise<VisionAnalysisResult>;
}

// ===== Azure OpenAI =====

class AzureOpenAIVisionProvider implements VisionProvider {
  readonly name = "azure_openai";
  readonly model: string;
  private endpoint: string;
  private apiKey: string;
  private deployment: string;
  private apiVersion: string;

  constructor() {
    this.endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
    this.apiKey = process.env.AZURE_OPENAI_API_KEY || "";
    this.deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1-mini";
    this.apiVersion =
      process.env.AZURE_OPENAI_API_VERSION || "2025-01-01-preview";
    this.model = this.deployment;

    if (!this.endpoint || !this.apiKey) {
      throw new Error(
        "Azure OpenAI requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY",
      );
    }
  }

  async analyze(
    imageBase64: string,
    prompt: string,
  ): Promise<VisionAnalysisResult> {
    const start = Date.now();
    const url = `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.apiKey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
              },
            ],
          },
        ],
        max_tokens: 100,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Azure OpenAI ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    const reply = data.choices?.[0]?.message?.content?.trim() || "";

    return {
      ...parseVerdict(reply),
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - start,
    };
  }
}

// ===== OpenAI =====

class OpenAIVisionProvider implements VisionProvider {
  readonly name = "openai";
  readonly model: string;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.model = process.env.OPENAI_MODEL || "gpt-4o";

    if (!this.apiKey) {
      throw new Error("OpenAI requires OPENAI_API_KEY");
    }
  }

  async analyze(
    imageBase64: string,
    prompt: string,
  ): Promise<VisionAnalysisResult> {
    const start = Date.now();

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
              },
            ],
          },
        ],
        max_tokens: 100,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    const reply = data.choices?.[0]?.message?.content?.trim() || "";

    return {
      ...parseVerdict(reply),
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - start,
    };
  }
}

// ===== Anthropic =====

class AnthropicVisionProvider implements VisionProvider {
  readonly name = "anthropic";
  readonly model: string;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

    if (!this.apiKey) {
      throw new Error("Anthropic requires ANTHROPIC_API_KEY");
    }
  }

  async analyze(
    imageBase64: string,
    prompt: string,
  ): Promise<VisionAnalysisResult> {
    const start = Date.now();

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: imageBase64,
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    const reply =
      data.content?.find((b: any) => b.type === "text")?.text?.trim() || "";

    return {
      ...parseVerdict(reply),
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - start,
    };
  }
}

// ===== Shared =====

function parseVerdict(reply: string): { failed: boolean; reason: string } {
  if (reply.startsWith("VERDICT: FAIL")) {
    const reason = reply
      .replace("VERDICT: FAIL", "")
      .replace(/^\s*\|\s*/, "")
      .trim();
    return { failed: true, reason: reason || "visual failure detected" };
  }
  return { failed: false, reason: reply };
}

/**
 * Create a vision provider based on environment configuration.
 *
 * Priority: VISION_PROVIDER env var → auto-detect from available API keys.
 * Throws with a clear message if no provider can be configured.
 */
export function createVisionProvider(): VisionProvider {
  const explicit = process.env.VISION_PROVIDER?.toLowerCase();

  if (explicit) {
    switch (explicit) {
      case "azure_openai":
      case "azure":
        return new AzureOpenAIVisionProvider();
      case "openai":
        return new OpenAIVisionProvider();
      case "anthropic":
        return new AnthropicVisionProvider();
      default:
        throw new Error(
          `Unknown VISION_PROVIDER "${explicit}". Use: azure_openai, openai, or anthropic`,
        );
    }
  }

  // Auto-detect from available API keys
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
    return new AzureOpenAIVisionProvider();
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIVisionProvider();
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicVisionProvider();
  }

  throw new Error(
    "No vision provider configured. Set one of:\n" +
      "  AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT (Azure OpenAI)\n" +
      "  OPENAI_API_KEY (OpenAI)\n" +
      "  ANTHROPIC_API_KEY (Anthropic)\n" +
      "Or explicitly set VISION_PROVIDER=azure_openai|openai|anthropic",
  );
}
