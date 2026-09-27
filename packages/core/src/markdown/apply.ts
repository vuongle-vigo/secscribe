/**
 * Suggestion application — spec §6.5. An accepted suggestion is applied by
 * exact string match of `original_quote`:
 *   exactly one match  → applicable
 *   multiple matches   → ambiguous, user must pick the occurrence
 *   zero matches       → stale, never guess
 */
export type MatchStatus = "applicable" | "ambiguous" | "stale";

export interface QuoteMatch {
  status: MatchStatus;
  /** All offsets where the quote occurs in the document. */
  offsets: number[];
}

export function findQuote(text: string, quote: string): QuoteMatch {
  if (!quote) return { status: "stale", offsets: [] };
  const offsets: number[] = [];
  let idx = text.indexOf(quote);
  while (idx !== -1) {
    offsets.push(idx);
    idx = text.indexOf(quote, idx + 1);
  }
  if (offsets.length === 1) return { status: "applicable", offsets };
  if (offsets.length === 0) return { status: "stale", offsets };
  return { status: "ambiguous", offsets };
}

export interface AppliedEdit {
  quote: string;
  replacement: string;
  /** Index into findQuote(text, quote).offsets — required for ambiguous quotes. */
  occurrence?: number;
}

export interface ApplyResult {
  text: string;
  applied: Array<{ quote: string; replacement: string; offset: number }>;
  /** Edits that could not be applied (stale, or occurrence out of range). */
  skipped: Array<{ quote: string; replacement: string; reason: string }>;
}

/**
 * Apply exact-match replacements; never mutates anything but the matched
 * ranges. Edits resolve against the ORIGINAL text; when an earlier edit has
 * already shifted or overwritten a later edit's span, the later edit is
 * skipped rather than guessed.
 */
export function applyEdits(text: string, edits: AppliedEdit[]): ApplyResult {
  const resolved: Array<{ offset: number; edit: AppliedEdit }> = [];
  const skipped: ApplyResult["skipped"] = [];

  for (const edit of edits) {
    const match = findQuote(text, edit.quote);
    if (match.status === "stale") {
      skipped.push({ ...edit, reason: "stale" });
      continue;
    }
    const occ = edit.occurrence ?? 0;
    const offset = match.offsets[Math.min(occ, match.offsets.length - 1)]!;
    if (offset === undefined) {
      skipped.push({ ...edit, reason: "occurrence-out-of-range" });
      continue;
    }
    resolved.push({ offset, edit });
  }

  // Apply ascending, tracking the length delta so original offsets stay
  // meaningful; verify the quoted span still matches before replacing.
  resolved.sort((a, b) => a.offset - b.offset || b.edit.quote.length - a.edit.quote.length);
  let out = text;
  let delta = 0;
  const applied: ApplyResult["applied"] = [];
  for (const { offset, edit } of resolved) {
    const at = offset + delta;
    if (out.slice(at, at + edit.quote.length) !== edit.quote) {
      skipped.push({ ...edit, reason: "overwritten-by-earlier-edit" });
      continue;
    }
    out = out.slice(0, at) + edit.replacement + out.slice(at + edit.quote.length);
    delta += edit.replacement.length - edit.quote.length;
    applied.push({ quote: edit.quote, replacement: edit.replacement, offset });
  }
  return { text: out, applied, skipped };
}
