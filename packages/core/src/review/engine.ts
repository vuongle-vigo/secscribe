/**
 * Review pipeline — spec §6. Masks the document, splits prose into sentences,
 * batches (~8) to the LLM with cache short-circuiting, validates responses
 * (one repair-retry, then drop), and enforces the markdown-safety rules.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "../config.js";
import { LlmClient, type ChatMessage } from "../llm/client.js";
import { maskDocument, intersectsProtection, PLACEHOLDER_RE, offsetToLine, lineStarts, type MaskedDocument } from "../markdown/segment.js";
import { splitSentences, type Sentence } from "../markdown/sentence.js";
import { findQuote, type MatchStatus } from "../markdown/apply.js";
import { parseReviewResponse } from "./schema.js";
import { cacheKey, ReviewCache, type CacheEntry } from "./cache.js";
import type { RawSuggestion, RawVocabulary } from "./schema.js";

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "review-system.md");

/**
 * The response schema from spec §6.4, embedded in every user prompt — the
 * system prompt says "matching the provided schema", so the schema must be
 * provided or models invent their own field names.
 */
const SCHEMA_BLOCK = `Return STRICT JSON only, exactly this shape:
{
  "suggestions": [
    {
      "id": "s1",
      "category": "grammar | word-choice | style | clarity | spelling",
      "severity": "error | minor",
      "original_quote": "exact verbatim substring of the source prose",
      "replacement": "corrected text",
      "reason_en": "short simple-English explanation, max 25 words",
      "reason_vi": "giải thích tiếng Việt",
      "alternatives": ["optional other phrasings"]
    }
  ],
  "vocabulary": [
    {
      "term": "reconnaissance",
      "phonetic": "/rɪˈkɒnɪsəns/",
      "definition_en": "...",
      "definition_vi": "...",
      "example_from_text": "sentence from the post containing the term",
      "synonyms": ["recon", "footprinting"],
      "tags": ["security", "methodology"]
    }
  ]
}`;

export function reviewSystemPrompt(): string {
  return readFileSync(PROMPT_PATH, "utf8").trim();
}

export function promptVersion(): string {
  return createHash("sha256").update(reviewSystemPrompt()).update(SCHEMA_BLOCK).digest("hex").slice(0, 8);
}

type SuggestionCategory = RawSuggestion["category"];
type SuggestionSeverity = RawSuggestion["severity"];

export interface Suggestion {
  id: string;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  originalQuote: string;
  replacement: string;
  reasonEn: string;
  reasonVi: string;
  alternatives: string[];
  sentenceHash: string;
  /** Line of the sentence the suggestion came from. */
  line: number;
  match: { status: MatchStatus; offsets: number[]; lines: number[] };
}

export interface VocabularyExtract {
  term: string;
  phonetic: string;
  definitionEn: string;
  definitionVi: string;
  /** User's own sentence containing the term (example_from_text or the reviewed sentence). */
  example: string;
  synonyms: string[];
  tags: string[];
  sentenceHash: string;
  line: number;
}

export interface ReviewStats {
  sentences: number;
  batchesSent: number;
  cacheHits: number;
  llmFailures: string[];
  rejectedSuggestions: number;
}

export interface ReviewUsage {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface ReviewResult {
  file: string;
  title: string | null;
  suggestions: Suggestion[];
  vocabulary: VocabularyExtract[];
  stats: ReviewStats;
  usage: ReviewUsage;
}

export interface ReviewOptions {
  text: string;
  /** Display/relative path of the file, recorded in history and card sources. */
  file: string;
  config: ResolvedConfig;
  cache: ReviewCache;
  /** Lazily constructed — only needed when at least one batch must be sent. */
  llm?: () => LlmClient;
  batchSize?: number;
  now?: () => Date;
}

const BATCH_SIZE = 8;

export async function reviewDocument(opts: ReviewOptions): Promise<ReviewResult> {
  const { text, file, config, cache } = opts;
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const masked = maskDocument(text);
  const sentences = splitSentences(masked);
  const starts = lineStarts(text);
  const pv = promptVersion();

  const suggestions: Suggestion[] = [];
  const vocabulary: VocabularyExtract[] = [];
  const stats: ReviewStats = {
    sentences: sentences.length,
    batchesSent: 0,
    cacheHits: 0,
    llmFailures: [],
    rejectedSuggestions: 0,
  };
  const usage: ReviewUsage = { promptTokens: 0, completionTokens: 0, requests: 0 };

  interface Pending {
    sentence: Sentence;
    key: string;
  }
  /** Batch result: the sentences a reply covered (singleton for cache hits). */
  interface BatchResult {
    sentences: Sentence[];
    suggestions: RawSuggestion[];
    vocabulary: RawVocabulary[];
  }
  const pending = new Map<string, Pending>();
  const results = new Map<string, BatchResult>();

  for (const sentence of sentences) {
    const key = cacheKey(sentence.text, config.model ?? "", pv);
    const cached = cache.get(key);
    if (cached && !(key in pending)) {
      stats.cacheHits++;
      results.set(key, { sentences: [sentence], suggestions: cached.suggestions, vocabulary: cached.vocabulary });
      continue;
    }
    if (!pending.has(key)) pending.set(key, { sentence, key });
  }

  let llm: LlmClient | null = null;
  const getLlm = (): LlmClient => {
    if (!llm) {
      llm = opts.llm
        ? opts.llm()
        : new LlmClient({
            baseUrl: config.baseUrl ?? "",
            apiKey: config.apiKey ?? "",
            model: config.model ?? "",
            temperature: config.temperature,
          });
    }
    return llm;
  };

  const pendingList = [...pending.values()];
  for (let i = 0; i < pendingList.length; i += batchSize) {
    const batch = pendingList.slice(i, i + batchSize);
    const reply = await reviewBatch(batch.map((p) => p.sentence), masked, config, getLlm, stats);
    if (reply) {
      usage.requests++;
      usage.promptTokens += reply.usage.promptTokens;
      usage.completionTokens += reply.usage.completionTokens;
      // Attribute each suggestion/vocab item to the sentence containing its
      // quote (fallback: the batch's first sentence) BEFORE caching, so a
      // later cache-hit run reports correct line numbers.
      const sentenceOf = (quote: string) =>
        batch.find((p) => p.sentence.text.includes(quote))?.sentence ?? batch[0]!.sentence;
      const lowerTermOf = (term: string) => term.toLowerCase();
      for (const p of batch) {
        // Attribute batch usage evenly across its sentences for status reporting.
        const share = { p: Math.round(reply.usage.promptTokens / batch.length), c: Math.round(reply.usage.completionTokens / batch.length) };
        const entry: CacheEntry = {
          t: now().toISOString(),
          model: config.model ?? "",
          usage: share,
          chars: p.sentence.text.length,
          suggestions: reply.data.suggestions.filter((raw) => sentenceOf(raw.original_quote) === p.sentence),
          vocabulary: reply.data.vocabulary.filter(
            (v) =>
              (batch.find((q) => q.sentence.text.toLowerCase().includes(lowerTermOf(v.term)))?.sentence ??
                batch[0]!.sentence) === p.sentence,
          ),
        };
        cache.set(p.key, entry);
      }
      results.set(batch[0]!.key, {
        sentences: batch.map((p) => p.sentence),
        suggestions: reply.data.suggestions,
        vocabulary: reply.data.vocabulary,
      });
    } else {
      results.set(batch[0]!.key, { sentences: batch.map((p) => p.sentence), suggestions: [], vocabulary: [] });
    }
  }

  // Convert raw results into safety-checked, match-resolved suggestions.
  // One reply covers several sentences; attribute each suggestion to the
  // sentence containing its quote (fallback: the batch's first sentence) and
  // dedupe by (id, quote) so a batch reply is never emitted twice.
  const seenSuggestions = new Set<string>();
  const seenVocab = new Set<string>();
  for (const { sentences: batchSentences, suggestions: rawSuggestions, vocabulary: rawVocab } of results.values()) {
    const first = batchSentences[0]!;
    for (const raw of rawSuggestions) {
      const key = `${raw.id}\u0000${raw.original_quote}`;
      if (seenSuggestions.has(key)) continue;
      const owner = batchSentences.find((s) => s.text.includes(raw.original_quote)) ?? first;
      if (!checkSafety(raw, masked, text)) {
        stats.rejectedSuggestions++;
        seenSuggestions.add(key);
        continue;
      }
      seenSuggestions.add(key);
      const match = findQuote(text, raw.original_quote);
      suggestions.push({
        id: raw.id,
        category: raw.category,
        severity: raw.severity,
        originalQuote: raw.original_quote,
        replacement: raw.replacement,
        reasonEn: raw.reason_en,
        reasonVi: raw.reason_vi,
        alternatives: raw.alternatives,
        sentenceHash: owner.hash,
        line: owner.line,
        match: {
          status: match.status,
          offsets: match.offsets,
          lines: match.offsets.map((o) => offsetToLine(starts, o)),
        },
      });
    }
    for (const v of rawVocab) {
      const key = v.term.toLowerCase();
      if (seenVocab.has(key)) continue;
      const lowerTerm = v.term.toLowerCase();
      const owner =
        batchSentences.find((s) => s.text.toLowerCase().includes(lowerTerm)) ?? first;
      seenVocab.add(key);
      vocabulary.push({
        term: v.term,
        phonetic: v.phonetic,
        definitionEn: v.definition_en,
        definitionVi: v.definition_vi,
        example: v.example_from_text || owner.text,
        synonyms: v.synonyms,
        tags: v.tags,
        sentenceHash: owner.hash,
        line: owner.line,
      });
    }
  }

  cache.save();
  suggestions.sort((a, b) => a.line - b.line || a.originalQuote.localeCompare(b.originalQuote));
  return { file, title: masked.title, suggestions, vocabulary, stats, usage };
}

interface BatchReply {
  data: { suggestions: RawSuggestion[]; vocabulary: RawVocabulary[] };
  usage: { promptTokens: number; completionTokens: number };
}

async function reviewBatch(
  batch: Sentence[],
  masked: MaskedDocument,
  config: ResolvedConfig,
  getLlm: () => LlmClient,
  stats: ReviewStats,
): Promise<BatchReply | null> {
  const system = reviewSystemPrompt();
  const sentenceLines = batch.map((s, i) => `[${i + 1}] ${s.text}`);
  const body = config.redactCodeInPrompt
    ? sentenceLines
    : // Unmasked mode: restore protections inside these sentences.
      sentenceLines.map((l) => restoreLine(l, masked));
  const userPrompt = [
    masked.title ? `Post title: ${masked.title}` : "Post title: (none)",
    "",
    "Sentences from the post:",
    ...body,
    "",
    SCHEMA_BLOCK,
    "",
    "Every original_quote must be an exact verbatim substring of the sentences above. Never include placeholders like ⟦C1⟧ in original_quote or replacement. No markdown fences, no commentary — JSON only.",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userPrompt },
  ];

  stats.batchesSent++;
  const llm = getLlm();
  let first: string;
  let firstUsage: { promptTokens: number; completionTokens: number };
  try {
    const r = await llm.chat(messages);
    first = r.content;
    firstUsage = { promptTokens: r.usage?.promptTokens ?? 0, completionTokens: r.usage?.completionTokens ?? 0 };
  } catch (err) {
    stats.llmFailures.push(`batch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  let parsed = parseReviewResponse(first);
  if (parsed.ok) return { data: parsed.data, usage: firstUsage };

  // One repair-retry (spec §6.4), then drop the batch.
  try {
    const repair = await llm.chat([
      ...messages,
      { role: "assistant", content: first.slice(0, 4000) },
      {
        role: "user",
        content: `Your previous reply was not valid JSON matching the schema (${parsed.issues.join("; ")}). ${SCHEMA_BLOCK}\n\nReturn ONLY the corrected JSON object — no markdown fences, no commentary.`,
      },
    ]);
    parsed = parseReviewResponse(repair.content);
    if (parsed.ok) {
      return {
        data: parsed.data,
        usage: {
          promptTokens: firstUsage.promptTokens + (repair.usage?.promptTokens ?? 0),
          completionTokens: firstUsage.completionTokens + (repair.usage?.completionTokens ?? 0),
        },
      };
    }
    stats.llmFailures.push(`batch dropped: model JSON still invalid (${parsed.issues.join("; ")})`);
  } catch (err) {
    stats.llmFailures.push(`batch dropped: repair call failed (${err instanceof Error ? err.message : String(err)})`);
  }
  return null;
}

/** Replace placeholders in one sentence with their original text (redactCodeInPrompt=false). */
function restoreLine(line: string, masked: MaskedDocument): string {
  let out = line;
  for (const p of masked.protections) {
    out = out.split(`⟦${p.ph}⟧`).join(p.text);
  }
  return out;
}

/**
 * Markdown-safety gate (spec §5/§11): reject any suggestion whose quote or
 * replacement contains a placeholder, or whose quoted range touches a
 * protected segment in the original document.
 */
function checkSafety(raw: RawSuggestion, masked: MaskedDocument, original: string): boolean {
  if (!raw.original_quote.trim()) return false;
  if (raw.replacement.includes("⟦") || raw.replacement.includes("⟧")) return false;
  if (PLACEHOLDER_RE.test(raw.original_quote) || PLACEHOLDER_RE.test(raw.replacement)) return false;
  if (raw.original_quote === raw.replacement) return false;
  // Range check: any occurrence of the quote must sit fully in prose.
  let idx = original.indexOf(raw.original_quote);
  if (idx === -1) return true; // will be marked stale by the match resolver
  while (idx !== -1) {
    if (intersectsProtection(masked, idx, idx + raw.original_quote.length)) return false;
    idx = original.indexOf(raw.original_quote, idx + 1);
  }
  return true;
}
