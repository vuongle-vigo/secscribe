/**
 * On-demand bilingual definitions for vocabulary cards (SPEC §7 backfill):
 * manually added terms and practice-derived cards carry no LLM definitions —
 * `defineTerm` asks the configured endpoint for a dictionary entry and the
 * store merge fills only the empty fields.
 */
import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { extractJson } from "../review/schema.js";

export const DefinitionSchema = z.object({
  phonetic: z.string().default(""),
  definition_en: z.string().default(""),
  definition_vi: z.string().default(""),
  synonyms: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  example: z.string().default(""),
});

export type Definition = z.infer<typeof DefinitionSchema>;

const DEFINE_SYSTEM = `You are a bilingual English–Vietnamese dictionary for a
Vietnamese security researcher studying English. Given one term, return its
dictionary entry STRICTLY as JSON only — no markdown fences, no commentary:
{"phonetic":"/rɪˈkɒnɪsəns/","definition_en":"max 20 simple words (CEFR B1)","definition_vi":"nghĩa tiếng Việt","synonyms":["..."],"tags":["security","english"],"example":"one English sentence that uses the term"}`;

/** Ask the endpoint for a definition; one repair-retry, then null. */
export async function defineTerm(llm: LlmClient, term: string): Promise<Definition | null> {
  const clean = term.trim();
  if (!clean) return null;
  const messages = [
    { role: "system" as const, content: DEFINE_SYSTEM },
    { role: "user" as const, content: `Define the term: ${clean}` },
  ];

  let first: string;
  try {
    first = (await llm.chat(messages)).content;
  } catch {
    return null;
  }
  const parsed = DefinitionSchema.safeParse(extractJson(first));
  if (parsed.success) return parsed.data;

  try {
    const repair = await llm.chat([
      ...messages,
      { role: "assistant", content: first.slice(0, 2000) },
      { role: "user", content: "That was not valid JSON matching the schema. Return ONLY the corrected JSON object." },
    ]);
    const retry = DefinitionSchema.safeParse(extractJson(repair.content));
    return retry.success ? retry.data : null;
  } catch {
    return null;
  }
}
