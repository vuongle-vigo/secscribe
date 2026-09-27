/** Zod schema for the LLM review response — spec §6.4. */
import { z } from "zod";

export const SuggestionCategory = z.enum(["grammar", "word-choice", "style", "clarity", "spelling"]);
export const SuggestionSeverity = z.enum(["error", "minor"]);

export const RawSuggestionSchema = z.object({
  id: z.string().min(1),
  category: SuggestionCategory,
  severity: SuggestionSeverity,
  original_quote: z.string(),
  replacement: z.string(),
  reason_en: z.string().min(1),
  reason_vi: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
});

export const RawVocabularySchema = z.object({
  term: z.string().min(1),
  phonetic: z.string().default(""),
  definition_en: z.string().default(""),
  definition_vi: z.string().default(""),
  example_from_text: z.string().default(""),
  synonyms: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const ReviewResponseSchema = z.object({
  suggestions: z.array(RawSuggestionSchema).default([]),
  vocabulary: z.array(RawVocabularySchema).default([]),
});

export type RawSuggestion = z.infer<typeof RawSuggestionSchema>;
export type RawVocabulary = z.infer<typeof RawVocabularySchema>;
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/**
 * Extract a JSON object from model output: tolerate markdown fences and
 * surrounding commentary, then parse. Returns null when no object parses.
 */
export function extractJson(content: string): unknown | null {
  let text = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text);
  if (fenced) text = fenced[1]!.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  const slice = text.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/** Parse + validate; returns a human-readable issue list on failure. */
export function parseReviewResponse(content: string): { ok: true; data: ReviewResponse } | { ok: false; issues: string[] } {
  const json = extractJson(content);
  if (json === null) return { ok: false, issues: ["output is not valid JSON"] };
  const parsed = ReviewResponseSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, issues };
  }
  return { ok: true, data: parsed.data };
}
