/**
 * Markdown segmentation — spec §5, the most important safety requirement.
 *
 * A document is partitioned into protected segments (YAML frontmatter, fenced
 * code blocks incl. nested/tilde fences, inline code, URLs/autolinks, raw
 * HTML) and prose. Protected segments are replaced with opaque placeholders
 * (`⟦C1⟧`, `⟦I2⟧`, …) before any text is sent to the LLM.
 */

export type ProtectedKind = "frontmatter" | "code" | "inline-code" | "url" | "html";

export interface Protection {
  /** Placeholder without the brackets, e.g. "C1". */
  ph: string;
  kind: ProtectedKind;
  /** Offsets in the ORIGINAL document. */
  start: number;
  end: number;
  text: string;
}

export interface ProseChunk {
  /** Offset of the chunk's first character in the original document. */
  start: number;
  /** Chunk text with inline protections replaced by placeholders. */
  masked: string;
  /** masked[i] -> original offset of that character (placeholders map to the protection start). */
  map: number[];
}

export interface MaskedDocument {
  original: string;
  /** The whole document with every protection replaced by its placeholder. */
  masked: string;
  protections: Protection[];
  proseChunks: ProseChunk[];
  title: string | null;
}

const KIND_LETTER: Record<ProtectedKind, string> = {
  frontmatter: "F",
  code: "C",
  "inline-code": "I",
  url: "U",
  html: "H",
};

/** Matches a line that opens a fenced code block: up to 6 spaces (list items) + ```/~~~ run. */
const FENCE_OPEN = /^ {0,6}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,6}(`{3,}|~{3,})\s*$/;

function lineEnd(doc: string, from: number): number {
  const nl = doc.indexOf("\n", from);
  return nl === -1 ? doc.length : nl;
}

/** Original start offset of every line (1-based lines start at 0). */
export function lineStarts(doc: string): number[] {
  const starts = [0];
  for (let i = 0; i < doc.length; i++) {
    if (doc[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

export function offsetToLine(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

interface Block {
  kind: ProtectedKind | "prose";
  start: number;
  end: number;
}

/** Phase 1: line-based scan for frontmatter and fenced code blocks. */
function scanBlocks(doc: string): Block[] {
  const blocks: Block[] = [];
  const len = doc.length;

  // YAML frontmatter: document must start with a `---` line and close with a
  // `---` (or `...`) line.
  if (/^---\r?\n/.test(doc)) {
    let pos = lineEnd(doc, 0) + 1;
    let close = -1;
    while (pos <= len) {
      const end = lineEnd(doc, pos);
      const line = doc.slice(pos, end).replace(/\r$/, "");
      if (line === "---" || line === "...") {
        close = end;
        break;
      }
      if (end >= len) break;
      pos = end + 1;
    }
    if (close !== -1) {
      blocks.push({ kind: "frontmatter", start: 0, end: close });
      // The newline after the closing `---` belongs to the following prose.
      return scanFences(doc, close, blocks);
    }
  }
  return scanFences(doc, 0, blocks);
}

function scanFences(doc: string, from: number, blocks: Block[]): Block[] {
  const len = doc.length;
  let pos = from;
  let proseStart = from;

  const flushProse = (end: number) => {
    if (end > proseStart) blocks.push({ kind: "prose", start: proseStart, end });
  };

  while (pos <= len) {
    const lineStart = pos;
    const end = lineEnd(doc, pos);
    const line = doc.slice(lineStart, end);
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const fenceChar = open[1]![0]!;
      const fenceLen = open[1]!.length;
      // Find the closing fence: same char, length >= opening, nothing else on the line.
      let cur = end + 1;
      let closeEnd = -1;
      while (cur <= len) {
        const curEnd = lineEnd(doc, cur);
        const curLine = doc.slice(cur, curEnd);
        const closeMatch = FENCE_CLOSE.exec(curLine);
        if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
          closeEnd = curEnd;
          break;
        }
        if (curEnd >= len) break;
        cur = curEnd + 1;
      }
      const blockEnd = closeEnd === -1 ? len : closeEnd;
      flushProse(lineStart);
      blocks.push({ kind: "code", start: lineStart, end: blockEnd });
      pos = blockEnd + 1;
      // The newline after the closing fence belongs to the following prose.
      proseStart = blockEnd;
      if (pos > len) break;
      continue;
    }
    if (end >= len) break;
    pos = end + 1;
  }
  flushProse(len);
  return blocks;
}

/**
 * Phase 2: inline protections inside prose. Alternatives are tried in order:
 * code spans (closing run must equal the opening run), HTML comments,
 * autolinks, HTML tags, markdown link destinations, bare URLs. The `d` flag
 * gives exact indices for each group so we can protect exactly the URL part
 * of `[text](url)`.
 */
const INLINE_RE =
  /(?<code>(?<ticks>`+)(?:(?!\k<ticks>)[\s\S])*?\k<ticks>)|(?<comment><!--[\s\S]*?-->)|(?<autolink><https?:\/\/[^\s>]+>)|(?<tag><\/?[A-Za-z][^\n>]*>)|(?<link>\]\(\s*)(?<url><[^\s>]*>|[^\s)]+)|(?<bare>https?:\/\/[^\s<>()\[\]{}"'`]+)/gd;

function protectInline(
  doc: string,
  start: number,
  end: number,
  protections: Protection[],
  counters: Record<ProtectedKind, number>,
): ProseChunk {
  const text = doc.slice(start, end);
  const maskedParts: string[] = [];
  const map: number[] = [];
  let cursor = start;

  const emitProse = (upto: number) => {
    for (let i = cursor; i < upto; i++) {
      maskedParts.push(doc[i]);
      map.push(i);
    }
  };

  const emitProtection = (pStart: number, pEnd: number, kind: ProtectedKind) => {
    counters[kind] += 1;
    const ph = `${KIND_LETTER[kind]}${counters[kind]}`;
    protections.push({ ph, kind, start: pStart, end: pEnd, text: doc.slice(pStart, pEnd) });
    for (const ch of `⟦${ph}⟧`) {
      maskedParts.push(ch);
      map.push(pStart);
    }
  };

  INLINE_RE.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(doc)) !== null) {
    if (m.index >= end) break;
    const groups = m.indices?.groups ?? {};
    if (groups["code"]) {
      emitProse(m.index);
      emitProtection(groups["code"][0], groups["code"][1], "inline-code");
      cursor = groups["code"][1];
    } else if (groups["comment"]) {
      emitProse(m.index);
      emitProtection(groups["comment"][0], groups["comment"][1], "html");
      cursor = groups["comment"][1];
    } else if (groups["tag"]) {
      emitProse(m.index);
      emitProtection(groups["tag"][0], groups["tag"][1], "html");
      cursor = groups["tag"][1];
    } else if (groups["autolink"]) {
      emitProse(m.index);
      emitProtection(groups["autolink"][0], groups["autolink"][1], "url");
      cursor = groups["autolink"][1];
    } else if (groups["url"]) {
      // `](` stays prose; only the destination is protected.
      emitProse(groups["url"][0]);
      emitProtection(groups["url"][0], groups["url"][1], "url");
      cursor = groups["url"][1];
    } else if (groups["bare"]) {
      emitProse(m.index);
      emitProtection(groups["bare"][0], groups["bare"][1], "url");
      cursor = groups["bare"][1];
    }
    INLINE_RE.lastIndex = cursor;
  }
  emitProse(end);

  return { start, masked: maskedParts.join(""), map };
}

/** Extract a post title: first `#` heading, else frontmatter `title:`. */
function extractTitle(doc: string, blocks: Block[]): string | null {
  const fm = blocks.find((b) => b.kind === "frontmatter");
  if (fm) {
    const fmText = doc.slice(fm.start, fm.end);
    const title = /^title:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m.exec(fmText);
    if (title) return (title[1] ?? title[2] ?? title[3] ?? "").trim() || null;
  }
  for (const b of blocks) {
    if (b.kind !== "prose") continue;
    const heading = /^#{1}\s+(.+?)\s*$/m.exec(doc.slice(b.start, b.end));
    if (heading) return heading[1]!.trim();
  }
  return null;
}

export function maskDocument(doc: string): MaskedDocument {
  const blocks = scanBlocks(doc);
  const protections: Protection[] = [];
  const counters: Record<ProtectedKind, number> = {
    frontmatter: 0,
    code: 0,
    "inline-code": 0,
    url: 0,
    html: 0,
  };
  const proseChunks: ProseChunk[] = [];
  const maskedParts: string[] = [];

  for (const block of blocks) {
    if (block.kind === "prose") {
      const chunk = protectInline(doc, block.start, block.end, protections, counters);
      proseChunks.push(chunk);
      maskedParts.push(chunk.masked);
    } else {
      counters[block.kind] += 1;
      const ph = `${KIND_LETTER[block.kind]}${counters[block.kind]}`;
      protections.push({
        ph,
        kind: block.kind,
        start: block.start,
        end: block.end,
        text: doc.slice(block.start, block.end),
      });
      maskedParts.push(`⟦${ph}⟧`);
    }
  }

  return {
    original: doc,
    masked: maskedParts.join(""),
    protections,
    proseChunks,
    title: extractTitle(doc, blocks),
  };
}

/** True when [start, end) intersects any protection range. */
export function intersectsProtection(md: MaskedDocument, start: number, end: number): boolean {
  return md.protections.some((p) => start < p.end && end > p.start);
}

export const PLACEHOLDER_RE = /⟦[FCIUH]\d+⟧/;
