/** Word-level diff (LCS) used to render suggestions, plus text normalization. */

export interface WordToken {
  text: string;
  /** Whitespace (incl. newline) that followed the token in the source. */
  space: string;
}

export function tokenizeWords(s: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /\S+( )?(\n*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    tokens.push({ text: m[0].replace(/[ \n]+$/, ""), space: m[0].slice(m[0].replace(/[ \n]+$/, "").length) });
  }
  return tokens;
}

export type DiffOp = { type: "same" | "del" | "ins"; text: string; space: string };

/** LCS diff over word tokens; whitespace rides along with its token. */
export function wordDiff(a: string, b: string): DiffOp[] {
  const at = tokenizeWords(a);
  const bt = tokenizeWords(b);
  const n = at.length;
  const m = bt.length;
  // dp[i][j] = LCS length of at[i..], bt[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = at[i]!.text === bt[j]!.text ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffOp["type"], tok: WordToken) => {
    const prev = ops[ops.length - 1];
    if (prev && prev.type === type) {
      prev.text += prev.space + tok.text;
      prev.space = tok.space;
    } else {
      ops.push({ type, text: tok.text, space: tok.space });
    }
  };
  while (i < n && j < m) {
    if (at[i]!.text === bt[j]!.text) {
      push("same", at[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push("del", at[i]!);
      i++;
    } else {
      push("ins", bt[j]!);
      j++;
    }
  }
  while (i < n) push("del", at[i++]!);
  while (j < m) push("ins", bt[j++]!);
  return ops;
}

/**
 * Normalization for practice-mode comparison (spec §9/§12): lowercase,
 * collapse whitespace, strip punctuation — but keep placeholder brackets ⟦⟧
 * intact so code placeholders compare equal.
 */
export function normalizeForComparison(s: string): string {
  return s
    .toLowerCase()
    .replace(/⟦/g, " ⟦")
    .replace(/⟧/g, "⟧ ")
    .replace(/[^\p{L}\p{N}\s⟦⟧]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type PracticeVerdict = "correct" | "partial" | "incorrect";

/**
 * Compare the user's typed fix against the suggestion's replacement.
 * correct: normalized equality. partial: >= 60% token overlap (LCS).
 */
export function gradeFix(userFix: string, expected: string): { verdict: PracticeVerdict; similarity: number } {
  const a = normalizeForComparison(userFix);
  const b = normalizeForComparison(expected);
  if (a === b) return { verdict: "correct", similarity: 1 };
  if (a.length === 0 || b.length === 0) return { verdict: "incorrect", similarity: 0 };
  const at = a.split(" ");
  const bt = b.split(" ");
  const n = at.length;
  const m = bt.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = at[i] === bt[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const similarity = dp[0]![0]! / Math.max(n, m);
  return { verdict: similarity >= 0.6 ? "partial" : "incorrect", similarity };
}
