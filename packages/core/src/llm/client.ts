/**
 * Minimal OpenAI-compatible Chat Completions client (spec §4). The only
 * network peer SecScribe ever talks to is the user-configured endpoint.
 * The API key is only ever sent as a Bearer header — never logged, never
 * persisted to workspace files.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage | null;
}

export interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  /** GLM reasoning switch: "auto" enables it only for Z.ai/bigmodel hosts. */
  disableThinking?: "auto" | "on" | "off";
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Normalize `baseUrl` to a full chat-completions endpoint URL. */
export function completionsUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  if (!/\/chat\/completions$/.test(url)) url += "/chat/completions";
  return url;
}

export class LlmClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: LlmClientConfig) {
    if (!cfg.baseUrl) throw new LlmError("baseUrl is not configured — run `secscribe init`");
    if (!cfg.apiKey) throw new LlmError("API key missing — set SECSRIBE_API_KEY or run `secscribe init`");
    this.url = completionsUrl(cfg.baseUrl);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  async chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature ?? 0.2,
      stream: false,
    };
    if (opts.maxTokens) body["max_tokens"] = opts.maxTokens;
    // GLM coding endpoints serve a reasoning model by default; a review batch
    // then reasons for minutes and the connection gets reset. Disable thinking
    // unless the user opted out — but only for GLM hosts, since other
    // OpenAI-compatible servers reject unknown parameters.
    if (this.shouldDisableThinking()) body["thinking"] = { type: "disabled" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(`request to ${this.cfg.baseUrl} timed out after ${this.timeoutMs}ms`);
      }
      throw new LlmError(`cannot reach ${this.cfg.baseUrl}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError(`endpoint returned HTTP ${res.status}: ${redact(text.slice(0, 300))}`, res.status);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (json.error) throw new LlmError(`endpoint error: ${redact(json.error.message ?? "unknown")}`);
    const raw = json.choices?.[0]?.message?.content;
    const content = Array.isArray(raw) ? raw.map((p) => p.text ?? "").join("") : (raw ?? "");
    if (!content) throw new LlmError("endpoint returned an empty completion");
    return {
      content,
      usage:
        json.usage && (json.usage.prompt_tokens != null || json.usage.completion_tokens != null)
          ? {
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0,
            }
          : null,
    };
  }

  private shouldDisableThinking(): boolean {
    const mode = this.cfg.disableThinking ?? "auto";
    if (mode === "off") return false;
    if (mode === "on") return true;
    try {
      const host = new URL(completionsUrl(this.cfg.baseUrl)).hostname;
      return host === "api.z.ai" || host.endsWith(".z.ai") || host.endsWith("bigmodel.cn") || host.endsWith(".bigmodel.cn");
    } catch {
      return false;
    }
  }

  /** Small connectivity/model check used by `secscribe init`. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const r = await this.chat(
        [
          { role: "system", content: "You are a connectivity test. Reply with exactly: OK" },
          { role: "user", content: "Reply with exactly: OK" },
        ],
        { temperature: 0, maxTokens: 10 },
      );
      const ok = /ok/i.test(r.content.trim().slice(0, 20));
      return { ok, message: ok ? `connected (${this.cfg.model})` : `unexpected reply: ${r.content.slice(0, 40)}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Never let an API key (or anything key-shaped) reach an error message. */
function redact(text: string): string {
  return text
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9_\-\.]{8,}/gi, "$1***")
    .replace(/"(api[_-]?key|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
}
