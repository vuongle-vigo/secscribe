import { describe, expect, it } from "vitest";
import { VocabularyStore, csvField, toAnkiCsv, cardFront, cardBack } from "../src/index.js";

function card(term: string, quote: string, over: Record<string, unknown> = {}) {
  const store = new VocabularyStore(null);
  const { card } = store.add({
    term,
    definition_en: `Meaning of ${term}`,
    definition_vi: `Nghĩa của ${term}`,
    synonyms: ["syn1"],
    tags: ["security", "web"],
    source: { file: "posts/x.md", quote },
    ...over,
  });
  return card;
}

/** Minimal RFC-4180 parser to verify what Anki would read back. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

describe("Anki CSV export", () => {
  it("escapes quotes by doubling and wraps fields with commas/quotes/newlines", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("emits front/back/tags columns that round-trip through a CSV parser", () => {
    const csv = toAnkiCsv([
      card("payload", 'The "payload" was delivered, twice'),
      card("reconnaissance", "We performed reconnaissance."),
    ]);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveLength(3);
    const [front, back, tags] = rows[0]!;
    expect(front).toBe('The "______" was delivered, twice');
    expect(back).toContain("**payload**");
    expect(back).toContain("Meaning of payload");
    expect(back).toContain("Nghĩa của payload");
    expect(back).toContain("posts/x.md");
    expect(tags).toContain("security");
    expect(tags).toContain("secscribe");
  });

  it("newlines inside fields become <br> so records stay one line (Anki 2.1.x)", () => {
    const csv = toAnkiCsv([card("multi", "first line\nsecond line")]);
    const physicalLines = csv.trimEnd().split("\n");
    expect(physicalLines).toHaveLength(1);
    expect(parseCsv(csv)[0]![1]).toContain("<br>");
  });

  it("cards without a source sentence fall back to a definition prompt", () => {
    const c = card("orphan", "");
    expect(cardFront(c)).toBe('What does “orphan” mean?');
    expect(cardBack(c)).toContain("**orphan**");
  });

  it("term missing from its own quote falls back gracefully", () => {
    const c = card("mismatch", "this quote never mentions it");
    expect(cardFront(c)).toBe('What does “mismatch” mean?');
  });
});
