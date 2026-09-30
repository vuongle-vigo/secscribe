/**
 * Sentence splitting with paragraph/position mapping — spec §6.1.
 * Sentences never cross paragraph (blank-line) boundaries, never include list
 * markers or blockquote prefixes, and carry a 1-based line number in the
 * original document.
 */
import { createHash } from "node:crypto";
import { lineStarts, offsetToLine, type MaskedDocument } from "./segment.js";

export interface Sentence {
  /** Verbatim sentence text (substring of the masked prose, trimmed). */
  text: string;
  /** 1-based line number of the sentence start in the original document. */
  line: number;
  /** sha256(text), first 16 hex chars — stable identity for history records. */
  hash: string;
}

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
  "a.m", "p.m", "approx", "fig", "no", "vol", "inc", "ltd", "co", "cf", "al",
]);

/** Matches only when the line actually starts with a blockquote and/or list marker. */
const PREFIX_RE = /^(\s*)(?:(?:>\s*)+(?:(?:[-*+]|\d{1,3}[.)])\s+)?|(?:[-*+]|\d{1,3}[.)])\s+)/;
const LEADING_WS_RE = /^\s*/;
const SENTENCE_END_RE = /[.!?…:]$/;

function isAbbreviationBefore(text: string, periodEnd: number): boolean {
  const m = /[A-Za-z][A-Za-z.]*$/.exec(text.slice(0, periodEnd));
  return m ? ABBREVIATIONS.has(m[0].toLowerCase()) : false;
}

/** A logical line: marker-stripped text plus per-char offsets into the chunk. */
interface Unit {
  text: string;
  /** offsets[i] = chunk-masked index of unit.text[i]. */
  offsets: number[];
  isTable: boolean;
}

function buildUnits(paragraphLines: string[], paragraphStart: number): Unit[] {
  const units: Unit[] = [];
  let off = paragraphStart;
  let carry: Unit | null = null;

  for (const raw of paragraphLines) {
    const isHeading = /^#{1,6}\s/.test(raw);
    const isTable = /^\s*\|/.test(raw);
    const prefix = PREFIX_RE.exec(raw);
    const contentStart = prefix ? prefix[0].length : LEADING_WS_RE.exec(raw)![0].length;
    const content = raw.slice(contentStart);

    const offsets: number[] = [];
    for (let i = 0; i < content.length; i++) offsets.push(off + contentStart + i);

    // A chunk that starts right after a code fence/frontmatter begins with
    // "\n": its first line is empty. Never join onto an empty carry — the
    // joining space would become leading whitespace and chop the first
    // character of the sentence (and poison its offset mapping).
    const carryUsable = carry !== null && carry.text.trim() !== "";
    const needsJoin =
      carryUsable &&
      !SENTENCE_END_RE.test(carry!.text.trimEnd()) &&
      !isHeading &&
      !isTable &&
      prefix === null &&
      content.length > 0;

    if (needsJoin && carry) {
      carry.text += " " + content;
      // The joining space maps to the last offset of the previous line.
      carry.offsets.push(carry.offsets[carry.offsets.length - 1]!);
      carry.offsets.push(...offsets);
    } else {
      if (carryUsable && carry) units.push(carry);
      carry = { text: content, offsets, isTable };
    }
    off += raw.length + 1; // + newline
  }
  if (carry && carry.text.trim() !== "") units.push(carry);
  return units;
}

export function splitSentences(md: MaskedDocument): Sentence[] {
  const starts = lineStarts(md.original);
  const sentences: Sentence[] = [];

  for (const chunk of md.proseChunks) {
    // Split into paragraphs on blank lines, tracking chunk-local offsets.
    const paragraphs: Array<{ start: number; end: number }> = [];
    const paraRe = /\n[ \t]*(?:\n[ \t]*)+/g;
    let last = 0;
    let pm: RegExpExecArray | null;
    while ((pm = paraRe.exec(chunk.masked)) !== null) {
      if (pm.index > last) paragraphs.push({ start: last, end: pm.index });
      last = pm.index + pm[0].length;
    }
    if (last < chunk.masked.length) paragraphs.push({ start: last, end: chunk.masked.length });

    for (const para of paragraphs) {
      const paraText = chunk.masked.slice(para.start, para.end);
      const lines = paraText.split("\n");
      for (const unit of buildUnits(lines, para.start)) {
        if (unit.isTable) continue; // table rows are layout, not prose
        const text = unit.text.trim();
        if (!text || !/\p{L}/u.test(text) || text.length < 3) continue;
        const lead = unit.text.length - unit.text.trimStart().length;

        // Indices into the trimmed text map into unit.text by adding `lead`.
        let sentenceBegin = 0;
        const splitRe = /([.!?…])(\s+)(?=[^a-z\s])/g;
        let sm: RegExpExecArray | null;
        while ((sm = splitRe.exec(text)) !== null) {
          if (isAbbreviationBefore(text, sm.index)) continue;
          emitSentence(text.slice(sentenceBegin, sm.index + 1), sentenceBegin);
          sentenceBegin = sm.index + sm[0].length;
        }
        emitSentence(text.slice(sentenceBegin), sentenceBegin);

        function emitSentence(s: string, textStart: number) {
          const t = s.trim();
          if (!t || !/\p{L}/u.test(t) || t.length < 3) return;
          const firstCharIdx = lead + textStart + (s.length - s.trimStart().length);
          const maskedIdx = unit.offsets[firstCharIdx];
          if (maskedIdx === undefined) return; // defensive: unmappable start
          const originalOffset = chunk.map[maskedIdx];
          if (originalOffset === undefined) return;
          sentences.push({
            text: t,
            line: offsetToLine(starts, originalOffset),
            hash: createHash("sha256").update(t).digest("hex").slice(0, 16),
          });
        }
      }
    }
  }
  return sentences;
}
