/**
 * Property test (spec §5/§12): a review run — and applying ALL accepted
 * suggestions — never mutates protected segments, and frontmatter keys/order
 * are untouched. The "LLM" is adversarial: it returns suggestions quoting
 * arbitrary spans of the document (including code) with arbitrary
 * replacements (including placeholder-shaped text).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskDocument } from "../src/markdown/segment.js";
import { applyEdits } from "../src/markdown/apply.js";
import { reviewDocument } from "../src/review/engine.js";
import { ReviewCache } from "../src/review/cache.js";
import { resolveConfig } from "../src/config.js";
import type { ChatMessage, ChatResult } from "../src/llm/client.js";

const WORDS = [
  "attacker", "payload", "bypass", "filter", "email", "scan", "host", "port",
  "CVE-2021-44228", "nmap", "-sV", "exploit", "hardening", "reconnaissance",
  "was", "were", "the", "a", "an", "use", "used", "deliver", "delivered",
];

const CODE_WORDS = ["rm", "-rf", "/", "const", "x=", "${VAR}", "&&", "||", "sudo", "nmap", "-sV", "127.0.0.1", "#!/bin/sh"];

const WORD = fc.constantFrom(...WORDS);
const CODE_WORD = fc.constantFrom(...CODE_WORDS);

const sentenceArb = fc
  .array(WORD, { minLength: 3, maxLength: 10 })
  .map((ws) => `${ws.join(" ")}.`);

const paraArb = fc.array(sentenceArb, { minLength: 1, maxLength: 4 }).map((ss) => ss.join(" "));

const codeBodyArb = fc.array(CODE_WORD, { minLength: 1, maxLength: 6 }).map((ws) => ws.join(" "));

const fenceArb = fc
  .record({ marker: fc.constantFrom("```", "~~~~", "````", "~~~"), lang: fc.constantFrom("", "bash", "python"), body: codeBodyArb })
  .map(({ marker, lang, body }) => {
    const close = marker.startsWith("~") ? "~".repeat(Math.max(3, marker.length)) : "`".repeat(Math.max(3, marker.length));
    return `${marker}${lang}\n${body}\n${close}`;
  });

const inlineCodeArb = fc
  .record({ ticks: fc.constantFrom("`", "``"), body: codeBodyArb })
  .map(({ ticks, body }) => `${ticks}${body}${ticks}`);

const urlLineArb = fc.constantFrom(
  "See https://cve.example/CVE-2024-1234 for details.",
  "Docs at <https://tool.example/docs> are useful.",
  "Check [the advisory](https://vendor.example/sec) today.",
);

const htmlLineArb = fc.constantFrom(
  "<div class=\"note\">advisory</div>",
  "<!-- internal note: verify --> then continue.",
  "Break<br>here.",
);

const frontmatterArb = fc.constantFrom("---\ntitle: Test Post\nauthor: researcher\n---");

const blockArb = fc.oneof(
  { withCrossShrink: true },
  paraArb,
  fenceArb,
  inlineCodeArb.map((c) => `Run ${c} now.`),
  urlLineArb,
  htmlLineArb,
);

const docArb = fc
  .record({
    frontmatter: fc.option(frontmatterArb, { nil: undefined }),
    blocks: fc.array(blockArb, { minLength: 1, maxLength: 8 }),
  })
  .map(({ frontmatter, blocks }) => {
    const parts = frontmatter ? [frontmatter, ...blocks] : blocks;
    return parts.join("\n\n");
  });

/** Adversarial replacement pool — includes placeholder-shaped strings. */
const REPLACEMENTS = ["fixed text", "the corrected wording", "⟦Z9⟧ leaked", "code `rm -rf /` here", "an updated phrase"];

interface AdversarialLlm {
  calls: number;
  chat(messages: ChatMessage[]): Promise<ChatResult>;
}

function makeAdversarialLlm(doc: string, seedRandom: () => number): AdversarialLlm {
  return {
    calls: 0,
    async chat(messages: ChatMessage[]) {
      this.calls++;
      if (seedRandom() < 0.12) {
        // Adversarial garbage: exercises the malformed-JSON drop path.
        return { content: "I refuse to answer in JSON, sorry!", usage: null };
      }
      const user = messages.filter((m) => m.role === "user").pop()?.content ?? "";
      const sentences = user
        .split("\n")
        .filter((l) => /^\[\d+\] /.test(l))
        .map((l) => l.replace(/^\[\d+\] /, ""));
      const suggestions = sentences.slice(0, 2).map((s, i) => {
        // Sometimes quote a random span of the RAW document (attacks code),
        // sometimes the sentence itself (legit).
        const useRawSpan = seedRandom() < 0.5 && doc.length > 10;
        let quote: string = s;
        if (useRawSpan) {
          const start = Math.floor(seedRandom() * Math.max(1, doc.length - 2));
          const len = 1 + Math.floor(seedRandom() * Math.min(20, doc.length - start));
          quote = doc.slice(start, start + len);
        }
        const replacement = REPLACEMENTS[Math.floor(seedRandom() * REPLACEMENTS.length)]!;
        return {
          id: `a${i + 1}`,
          category: "grammar" as const,
          severity: "error" as const,
          original_quote: quote,
          replacement,
          reason_en: "adversarial",
          reason_vi: "đối kháng",
          alternatives: [],
        };
      });
      return {
        content: JSON.stringify({ suggestions, vocabulary: [] }),
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: protected segments are sacred (spec §5)", () => {
  it("review + apply-all never mutates protected segments; frontmatter untouched", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 30 }), docArb, async (seed, doc) => {
        const masked = maskDocument(doc);
        const llm = makeAdversarialLlm(doc, prng(seed));
        const result = await reviewDocument({
          text: doc,
          file: "property.md",
          config: resolveConfig({ workspaceRoot: null, flags: { baseUrl: "http://stub", apiKey: "k", model: "m" } }),
          cache: new ReviewCache(null),
          llm: () => llm as never,
        });

        // No suggestion may carry a placeholder in quote or replacement.
        for (const s of result.suggestions) {
          expect(s.originalQuote).not.toMatch(/⟦[A-Z]\d+⟧/);
          expect(s.replacement).not.toMatch(/⟦[A-Z]\d+⟧/);
        }

        // Every applied edit range must sit entirely in prose.
        const accepted = result.suggestions
          .filter((s) => s.match.status !== "stale")
          .map((s) => ({ quote: s.originalQuote, replacement: s.replacement, occurrence: 0 }));
        const applied = applyEdits(doc, accepted);

        for (const edit of applied.applied) {
          for (const p of masked.protections) {
            const overlaps = edit.offset < p.end && edit.offset + edit.quote.length > p.start;
            expect(overlaps).toBe(false);
          }
        }

        // Every original protected text survives byte-for-byte in the result.
        for (const p of masked.protections) {
          expect(applied.text.includes(p.text)).toBe(true);
        }
        if (masked.protections[0]?.kind === "frontmatter") {
          expect(applied.text.startsWith(masked.protections[0].text)).toBe(true);
        }

        // With zero accepted suggestions the document is byte-identical.
        const none = applyEdits(doc, []);
        expect(none.text).toBe(doc);
      }),
      { numRuns: 150 },
    );
  });
});
