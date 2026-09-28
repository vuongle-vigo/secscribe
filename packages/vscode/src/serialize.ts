/** Serialize a ReviewResult into the webview payload (diffs precomputed). */
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
  original: string;
  replacement: string;
  diff: PanelDiffOp[];
  reasonEn: string;
  reasonVi: string;
  alternatives: string[];
  sentenceHash: string;
}

export interface PanelPayload {
  type: "review";
  file: string;
  title: string | null;
  applyMode: "self" | "assist";
  suggestions: PanelSuggestion[];
  stats: { sentences: number; cacheHits: number; batchesSent: number; rejected: number };
  dismissedCount: number;
}

export function toPanelPayload(
  result: ReviewResult,
  dismissed: ReadonlySet<string>,
  applyMode: "self" | "assist",
): PanelPayload {
  return {
    type: "review",
    file: result.file,
    title: result.title,
    applyMode,
    suggestions: result.suggestions
      .filter((s) => !dismissed.has(s.id))
      .map((s) => ({
        id: s.id,
        category: s.category,
        severity: s.severity,
        line: s.line,
        matchStatus: s.match.status,
        original: s.originalQuote,
        replacement: s.replacement,
        diff: wordDiff(s.originalQuote, s.replacement).map((op) => ({
          type: op.type,
          text: op.text + op.space,
        })),
        reasonEn: s.reasonEn,
        reasonVi: s.reasonVi,
        alternatives: s.alternatives,
        sentenceHash: s.sentenceHash,
      })),
    stats: {
      sentences: result.stats.sentences,
      cacheHits: result.stats.cacheHits,
      batchesSent: result.stats.batchesSent,
      rejected: result.stats.rejectedSuggestions,
    },
    dismissedCount: dismissed.size,
  };
}
