import { describe, expect, it } from "vitest";
import { ReviewCache } from "../src/review/cache.js";
import { reviewDocument, promptVersion } from "../src/review/engine.js";
import type { ChatMessage, ChatResult } from "../src/llm/client.js";
import { resolveConfig } from "../src/config.js";
import { completion, echoResponder, startFakeServer } from "./helpers/fake-server.js";

const DOC = [
  "# Phishing Analysis",
  "",
  "The attacker use a payload delivered by email. Two filters was bypassed.",
  "",
  "```bash",
  "curl -X POST https://internal.example/api --data 'secret'",
  "```",
  "",
  "We performed reconnaissance on the subnet.",
].join("\n");

function config(over: Record<string, unknown> = {}) {
  return resolveConfig({
    workspaceRoot: null,
    flags: { baseUrl: "http://fake/v1", apiKey: "test-key", model: "test-model", ...over },
  });
}

/** In-process stub LLM: scriptable replies + call counting. */
function stubLlm(replies: Array<() => ChatResult | Promise<ChatResult>>) {
  const calls: ChatMessage[][] = [];
  const impl = {
    calls,
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      calls.push(messages);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (!reply) throw new Error("no scripted reply");
      return reply();
    },
  };
  return () => ({
    chat: impl.chat.bind(impl),
    callsRef: calls,
  });
}

describe("review engine (spec §6)", () => {
  it("masked sentences go to the LLM; suggestions come back with match info", async () => {
    const fake = await startFakeServer(echoResponder());
    try {
      const result = await reviewDocument({
        text: DOC,
        file: "post.md",
        config: config({ baseUrl: fake.url }),
        cache: new ReviewCache(null),
        llm: undefined as never,
      });
      expect(fake.requests.length).toBeGreaterThan(0);
      // Authorization header sent, key never in the body
      expect(fake.requests[0]!.auth).toBe("Bearer test-key");
      expect(JSON.stringify(fake.requests[0]!.body)).not.toContain("test-key");
      // Prose sent, code never
      const sent = JSON.stringify(fake.requests[0]!.body.messages);
      expect(sent).toContain("The attacker use a payload");
      expect(sent).not.toContain("internal.example");
      expect(sent).not.toContain("curl -X POST");
      expect(result.title).toBe("Phishing Analysis");
      expect(result.suggestions.length).toBeGreaterThanOrEqual(2);
      for (const s of result.suggestions) {
        expect(["applicable", "ambiguous", "stale"]).toContain(s.match.status);
        expect(s.reasonEn).toBeTruthy();
        expect(s.reasonVi).toBeTruthy();
      }
      expect(result.vocabulary.length).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  });

  it("batches ~8 sentences per request", async () => {
    const sentences = Array.from({ length: 17 }, (_, i) => `Sentence number ${i} has an error.`).join(" ");
    const fake = await startFakeServer(echoResponder());
    try {
      await reviewDocument({
        text: sentences,
        file: "x.md",
        config: config({ baseUrl: fake.url }),
        cache: new ReviewCache(null),
        llm: undefined as never,
      });
      expect(fake.requests.length).toBe(3); // 8 + 8 + 1
    } finally {
      await fake.close();
    }
  });

  it("one repair-retry for malformed JSON, then success", async () => {
    let call = 0;
    const fake = await startFakeServer((req, i) => {
      call++;
      if (call === 1) return completion("Sorry, I cannot answer that right now.");
      // The repair call must include the bad assistant reply + a user correction ask
      const roles = req.body.messages.map((m) => m.role);
      expect(roles).toContain("assistant");
      return completion(JSON.stringify({ suggestions: [], vocabulary: [] }));
    });
    try {
      const result = await reviewDocument({
        text: "One bad sentence here.",
        file: "x.md",
        config: config({ baseUrl: fake.url }),
        cache: new ReviewCache(null),
        llm: undefined as never,
      });
      expect(fake.requests).toHaveLength(2);
      expect(result.stats.llmFailures).toEqual([]);
      expect(result.suggestions).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("drops the batch after a failed repair (never throws)", async () => {
    const fake = await startFakeServer(() => completion("still not json {{{"));
    try {
      const result = await reviewDocument({
        text: "One bad sentence here.",
        file: "x.md",
        config: config({ baseUrl: fake.url }),
        cache: new ReviewCache(null),
        llm: undefined as never,
      });
      expect(fake.requests).toHaveLength(2); // initial + one repair
      expect(result.stats.llmFailures).toHaveLength(1);
      expect(result.stats.llmFailures[0]).toContain("dropped");
      expect(result.suggestions).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("rejects suggestions that contain placeholders or touch protected text", async () => {
    const fake = await startFakeServer(() =>
      completion(
        JSON.stringify({
          suggestions: [
            {
              id: "evil1",
              category: "grammar",
              severity: "error",
              original_quote: "run ⟦C1⟧ now",
              replacement: "execute ⟦C1⟧ now",
              reason_en: "placeholder in quote and replacement",
              reason_vi: "placeholder",
              alternatives: [],
            },
            {
              id: "evil2",
              category: "grammar",
              severity: "error",
              original_quote: "`nmap -sV` and then",
              replacement: "`nmap -sV`, and then",
              reason_en: "spanning inline code plus prose",
              reason_vi: "chạm vào inline code",
              alternatives: [],
            },
            {
              id: "ok1",
              category: "grammar",
              severity: "error",
              original_quote: "The attacker use a payload delivered by email",
              replacement: "The attacker used a payload delivered by email",
              reason_en: "past tense",
              reason_vi: "thì quá khứ",
              alternatives: [],
            },
          ],
          vocabulary: [],
        }),
      ),
    );
    try {
      const result = await reviewDocument({
        text: "The attacker use a payload delivered by email. We ran `nmap -sV` and then stopped.",
        file: "x.md",
        config: config({ baseUrl: fake.url }),
        cache: new ReviewCache(null),
        llm: undefined as never,
      });
      const ids = result.suggestions.map((s) => s.id);
      expect(ids).toEqual(["ok1"]);
      expect(result.stats.rejectedSuggestions).toBe(2);
    } finally {
      await fake.close();
    }
  });

  it("cached reruns report the same lines as the live run (attribution survives cache)", async () => {
    const fake = await startFakeServer(echoResponder());
    const cache = new ReviewCache(null);
    const cfg = config({ baseUrl: fake.url });
    const text = "# Heading line\n\nThe attacker use a payload.\n\nAnother sentence exists.";
    try {
      const r1 = await reviewDocument({ text, file: "x.md", config: cfg, cache, llm: undefined as never });
      const r2 = await reviewDocument({
        text,
        file: "x.md",
        config: cfg,
        cache,
        llm: () => {
          throw new Error("cache must cover the whole rerun");
        },
      });
      expect(r1.suggestions.map((s) => [s.id, s.line])).toEqual(r2.suggestions.map((s) => [s.id, s.line]));
      const prose = r2.suggestions.find((s) => s.originalQuote.includes("attacker"));
      expect(prose?.line).toBe(3); // the sentence's line, not the heading's
    } finally {
      await fake.close();
    }
  });

  it("cache short-circuits: unchanged sentences are never re-sent", async () => {
    const fake = await startFakeServer(echoResponder());
    const cache = new ReviewCache(null);
    try {
      await reviewDocument({ text: DOC, file: "p.md", config: config({ baseUrl: fake.url }), cache, llm: undefined as never });
      const afterFirst = fake.requests.length;
      expect(afterFirst).toBeGreaterThan(0);

      const second = await reviewDocument({
        text: DOC,
        file: "p.md",
        config: config({ baseUrl: fake.url }),
        cache,
        llm: undefined as never,
      });
      expect(fake.requests.length).toBe(afterFirst); // nothing re-sent
      expect(second.stats.cacheHits).toBe(second.stats.sentences);
      expect(second.suggestions.length).toBeGreaterThan(0); // still reported from cache
    } finally {
      await fake.close();
    }
  });

  it("stale quotes are marked, never guessed", async () => {
    const fake = await startFakeServer(() =>
      completion(
        JSON.stringify({
          suggestions: [
            {
              id: "ghost",
              category: "grammar",
              severity: "error",
              original_quote: "this quote does not exist",
              replacement: "anything",
              reason_en: "x",
              reason_vi: "x",
              alternatives: [],
            },
          ],
          vocabulary: [],
        }),
      ),
    );
    try {
      const result = await reviewDocument({
        text: "Unrelated prose entirely.",
        file: "x.md",
        config: config({ baseUrl: fake.url }),
        cache: new ReviewCache(null),
        llm: undefined as never,
      });
      expect(result.suggestions[0]!.match.status).toBe("stale");
    } finally {
      await fake.close();
    }
  });

  it("prompt version is derived from the system prompt file", () => {
    expect(promptVersion()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("works fully offline when every sentence is cached", async () => {
    const cache = new ReviewCache(null);
    // Prime the cache via a stub LLM instead of a server.
    const stub = stubLlm([
      () => ({
        content: JSON.stringify({
          suggestions: [
            {
              id: "s1",
              category: "grammar",
              severity: "error",
              original_quote: "Cached sentence only.",
              replacement: "Cached sentence fixed.",
              reason_en: "cache",
              reason_vi: "cache",
              alternatives: [],
            },
          ],
          vocabulary: [],
        }),
        usage: { promptTokens: 12, completionTokens: 3 },
      }),
    ]);
    const provider = stub();
    await reviewDocument({
      text: "Cached sentence only.",
      file: "x.md",
      config: config(),
      cache,
      llm: () => provider as never,
    });

    // Second run with a provider that would throw if called.
    const offline = await reviewDocument({
      text: "Cached sentence only.",
      file: "x.md",
      config: config(),
      cache,
      llm: () => {
        throw new Error("network should not be touched");
      },
    });
    expect(offline.suggestions[0]!.replacement).toBe("Cached sentence fixed.");
    expect(offline.stats.cacheHits).toBe(1);
  });
});
