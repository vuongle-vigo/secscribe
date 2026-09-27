/** Cloze card generation — spec §7: blank the term inside the user's own sentence. */

export const BLANK = "______";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace occurrences of `term` (whole-word, case-insensitive) in `sentence`
 * with the blank. Returns the sentence unchanged when no match exists.
 */
export function makeCloze(sentence: string, term: string): { front: string; found: boolean } {
  if (!term.trim()) return { front: sentence, found: false };
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(term.trim())})(?=[^\\p{L}\\p{N}]|$)`, "giu");
  let found = false;
  const front = sentence.replace(re, (_m, pre: string, matched: string) => {
    found = true;
    return pre + BLANK;
  });
  return { front, found };
}
