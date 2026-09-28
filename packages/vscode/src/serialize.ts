/** Serialize core results into webview payloads (diffs precomputed). */
import { wordDiff, type ReviewResult } from "@secscribe/core";

export interface PanelDiffOp {
  type: "same" | "del" | "ins";
  text: string;
}

export interface PanelSuggestion {
  id: string;
  category: string;
  severity: "error" | "minor";
  /** 1-based line of the sentence the suggestion came from. */
  line: number;
  matchStatus: "applicable" | "ambiguous" | "stale";
  /** Lines of every occurrence (for the ambiguous picker). */
  matchLines: number[];
  original: string;
  replacement: string;
  diff: PanelDiffOp[];
  reasonEn: string;
  reasonVi: string;
  alternatives: string[];
  /** Full source sentence — practice flashcards learn the corrected version. */
  sentence: string;
  sentenceHash: string;
}

export interface PanelPayload {
  type: "review";
  file: string;
  title: string | null;
  applyMode: "self" | "assist";
  practiceMode: boolean;
  suggestions: PanelSuggestion[];
  stats: { sentences: number; cacheHits: number; batchesSent: number; rejected: number };
  dismissedCount: number;
  appliedCount: number;
}

export function toPanelPayload(
  result: ReviewResult,
  dismissed: ReadonlySet<string>,
  applied: ReadonlySet<string>,
  applyMode: "self" | "assist",
  practiceMode: boolean,
): PanelPayload {
  const sentenceByHash = new Map(result.sentences.map((s) => [s.hash, s.text]));
  return {
    type: "review",
    file: result.file,
    title: result.title,
    applyMode,
    practiceMode,
    suggestions: result.suggestions
      .filter((s) => !dismissed.has(s.id) && !applied.has(s.id))
      .map((s) => ({
        id: s.id,
        category: s.category,
        severity: s.severity,
        line: s.line,
        matchStatus: s.match.status,
        matchLines: s.match.lines,
        original: s.originalQuote,
        replacement: s.replacement,
        diff: wordDiff(s.originalQuote, s.replacement).map((op) => ({
          type: op.type,
          text: op.text + op.space,
        })),
        reasonEn: s.reasonEn,
        reasonVi: s.reasonVi,
        alternatives: s.alternatives,
        sentence: sentenceByHash.get(s.sentenceHash) ?? s.originalQuote,
        sentenceHash: s.sentenceHash,
      })),
    stats: {
      sentences: result.stats.sentences,
      cacheHits: result.stats.cacheHits,
      batchesSent: result.stats.batchesSent,
      rejected: result.stats.rejectedSuggestions,
    },
    dismissedCount: dismissed.size,
    appliedCount: applied.size,
  };
}
