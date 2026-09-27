import { describe, expect, it } from "vitest";
import { maskDocument } from "../src/markdown/segment.js";
import { splitSentences } from "../src/markdown/sentence.js";

function sentences(doc: string) {
  return splitSentences(maskDocument(doc)).map((s) => s.text);
}

describe("sentence splitting", () => {
  it("splits on . ! ? followed by a capital", () => {
    expect(sentences("The scan finished. We found three hosts! Is it patched? Yes.")).toEqual([
      "The scan finished.",
      "We found three hosts!",
      "Is it patched?",
      "Yes.",
    ]);
  });

  it("does not split after common abbreviations", () => {
    expect(sentences("Use nmap, e.g. nmap -sV. Then report.")).toEqual([
      "Use nmap, e.g. nmap -sV.",
      "Then report.",
    ]);
    expect(sentences("See Dr. Smith about CVE-2021-44228. He knows.")).toEqual([
      "See Dr. Smith about CVE-2021-44228.",
      "He knows.",
    ]);
  });

  it("does not split inside placeholders (masked code)", () => {
    const doc = "We ran `nmap -sV 10.0.0.1` first. Then we stopped.";
    const ss = sentences(doc);
    expect(ss).toHaveLength(2);
    expect(ss[0]).toContain("⟦I1⟧");
  });

  it("joins soft line breaks within a paragraph but never crosses blank lines", () => {
    const doc = "This sentence continues\non the next line.\n\nA new paragraph starts here.";
    expect(sentences(doc)).toEqual([
      "This sentence continues on the next line.",
      "A new paragraph starts here.",
    ]);
  });

  it("strips list markers and blockquote prefixes", () => {
    const doc = "Steps:\n\n- first we scan the host\n- second we exploit\n\n> quoted line stays.";
    const ss = sentences(doc);
    expect(ss).toContain("first we scan the host");
    expect(ss).toContain("second we exploit");
    expect(ss).toContain("quoted line stays.");
  });

  it("keeps sentence text a verbatim substring of the masked document", () => {
    const doc = "The payload was deliver via email, not HTTP. It bypass two filters.";
    const md = maskDocument(doc);
    for (const s of splitSentences(md)) {
      expect(md.masked.includes(s.text)).toBe(true);
    }
  });

  it("skips symbol-only and very short fragments", () => {
    expect(sentences("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([]);
  });

  it("sentence hashes are stable and content-derived", () => {
    const a = splitSentences(maskDocument("Same text here. Different text."))
      .find((s) => s.text === "Same text here.")!;
    const b = splitSentences(maskDocument("Other. Same text here."))
      .find((s) => s.text === "Same text here.")!;
    expect(a.hash).toBe(b.hash);
  });
});
