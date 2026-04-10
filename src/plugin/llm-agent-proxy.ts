/**
 * LLM proxy for implicit NPC behaviors and soul generation.
 * Reads provider config from OpenClaw runtime (rt.config.loadConfig()),
 * resolves env-templated API keys from the config's env section,
 * and makes direct HTTP calls. Falls back to process.env for QClaw compatibility.
 */

import { getTownRuntime } from "./runtime.js";

export interface LLMChatRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  stop: string[];
}

export interface LLMChatResult {
  text: string;
  usage?: { input: number; output: number };
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: "anthropic-messages" | "openai";
}

const MAX_CONCURRENT = 2;
const MAX_QUEUE = 10;

function resolveEnvRef(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => env[key] ?? process.env[key] ?? "");
}

function loadProvider(): ProviderConfig | null {
  try {
    const rt = getTownRuntime();
    const cfg = rt.config.loadConfig() as any;
    const configVars: Record<string, string> = cfg?.env ?? {};
    const providers = cfg?.models?.providers;
    if (!providers || typeof providers !== "object") return null;

    for (const [, provider] of Object.entries(providers) as [string, any][]) {
      if (!provider.baseUrl || !provider.apiKey) continue;
      const apiKey = resolveEnvRef(String(provider.apiKey), configVars);
      if (!apiKey) continue;

      const apiFormat = provider.api?.startsWith("openai") ? "openai" as const : "anthropic-messages" as const;
      const models = Array.isArray(provider.models) ? provider.models : [];
      const model = models[0]?.id ?? "default";

      return {
        baseUrl: String(provider.baseUrl).replace(/\/+$/, ""),
        apiKey,
        model,
        apiFormat,
      };
    }
  } catch (err) {
    console.warn("[llm-agent-proxy] Failed to load provider:", (err as Error).message);
  }
  return null;
}

async function callAnthropicMessages(config: ProviderConfig, req: LLMChatRequest): Promise<LLMChatResult> {
  const body = {
    model: config.model,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    ...(req.stop.length > 0 ? { stop_sequences: req.stop } : {}),
  };

  const url = `${config.baseUrl}/v1/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = data.content?.find(b => b.type === "text")?.text ?? "";
  return {
    text,
    usage: data.usage
      ? { input: data.usage.input_tokens ?? 0, output: data.usage.output_tokens ?? 0 }
      : undefined,
  };
}

async function callOpenAI(config: ProviderConfig, req: LLMChatRequest): Promise<LLMChatResult> {
  const body = {
    model: config.model,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    ...(req.stop.length > 0 ? { stop: req.stop } : {}),
  };

  const url = `${config.baseUrl}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI API ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  return {
    text,
    usage: data.usage
      ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 }
      : undefined,
  };
}

let activeRequests = 0;
const requestQueue: Array<{
  req: LLMChatRequest;
  resolve: (r: LLMChatResult) => void;
  reject: (e: Error) => void;
}> = [];

function drainQueue(): void {
  if (requestQueue.length === 0 || activeRequests >= MAX_CONCURRENT) return;
  const next = requestQueue.shift()!;
  executeChat(next.req).then(next.resolve, next.reject);
}

async function executeChat(req: LLMChatRequest): Promise<LLMChatResult> {
  activeRequests++;
  try {
    const config = loadProvider();
    if (!config) return { text: "" };
    return config.apiFormat === "openai"
      ? await callOpenAI(config, req)
      : await callAnthropicMessages(config, req);
  } catch (err) {
    console.warn("[llm-agent-proxy] chat error:", (err as Error).message);
    return { text: "" };
  } finally {
    activeRequests--;
    drainQueue();
  }
}

export async function chat(req: LLMChatRequest): Promise<LLMChatResult> {
  if (activeRequests >= MAX_CONCURRENT) {
    return new Promise<LLMChatResult>((resolve, reject) => {
      if (requestQueue.length >= MAX_QUEUE) {
        resolve({ text: "" });
        return;
      }
      requestQueue.push({ req, resolve, reject });
    });
  }
  return executeChat(req);
}

export function isAvailable(): boolean {
  return loadProvider() !== null;
}
