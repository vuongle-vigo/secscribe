import { describe, expect, it } from "vitest";
import { maskDocument, intersectsProtection, PLACEHOLDER_RE } from "../src/markdown/segment.js";
import { splitSentences } from "../src/markdown/sentence.js";

function kinds(doc: string) {
  return maskDocument(doc).protections.map((p) => p.kind);
}
function texts(doc: string) {
  return maskDocument(doc).protections.map((p) => p.text);
}
function phs(doc: string) {
  return maskDocument(doc).protections.map((p) => `⟦${p.ph}⟧`);
}

describe("markdown segmenter", () => {
  it("protects YAML frontmatter as one segment", () => {
    const doc = `---\ntitle: My Post\n tags: [recon]\n---\n\nProse here.\n`;
    const md = maskDocument(doc);
    expect(md.protections).toHaveLength(1);
    expect(md.protections[0]!.kind).toBe("frontmatter");
    expect(md.protections[0]!.text).toBe("---\ntitle: My Post\n tags: [recon]\n---");
    expect(md.title).toBe("My Post");
    expect(md.masked.startsWith("⟦F1⟧")).toBe(true);
  });

  it("protects backtick fenced code blocks", () => {
    const doc = `Intro line.\n\n\`\`\`bash\nnmap -sV 10.0.0.1\n\`\`\`\n\nOutro line.`;
    const md = maskDocument(doc);
    expect(md.protections).toHaveLength(1);
    expect(md.protections[0]!.kind).toBe("code");
    expect(md.protections[0]!.text).toContain("nmap -sV");
    expect(md.masked).not.toContain("nmap");
    expect(md.proseChunks.some((c) => c.masked.includes("Intro line."))).toBe(true);
    expect(md.proseChunks.some((c) => c.masked.includes("Outro line."))).toBe(true);
  });

  it("protects tilde fences", () => {
    const doc = `text\n\n~~~python\nprint("hi")\n~~~\n\nmore text`;
    expect(kinds(doc)).toEqual(["code"]);
    expect(texts(doc)[0]).toContain('print("hi")');
  });

  it("handles nested fences: 4-backtick fence containing a 3-backtick fence", () => {
    const inner = "```\nls -la\n```";
    const doc = `before\n\n\`\`\`\`\n${inner}\n\`\`\`\`\n\nafter`;
    const md = maskDocument(doc);
    expect(md.protections).toHaveLength(1);
    expect(md.protections[0]!.text).toBe("````\n```\nls -la\n```\n````");
    expect(md.masked).not.toContain("ls -la");
    expect(md.masked).toContain("before");
    expect(md.masked).toContain("after");
  });

  it("keeps tilde and backtick fences separate", () => {
    const doc = "~~~\n```code inside tilde```\n~~~\nprose";
    const md = maskDocument(doc);
    expect(md.protections).toHaveLength(1);
    expect(md.protections[0]!.text).toContain("```code inside tilde```");
  });

  it("protects indented fences inside list items", () => {
    const doc = "Steps:\n\n  - first\n  - run it:\n\n    ```sh\n    curl http://x\n    ```\n\ndone";
    const md = maskDocument(doc);
    const code = md.protections.find((p) => p.kind === "code");
    expect(code).toBeDefined();
    expect(code!.text).toContain("curl http://x");
  });

  it("protects an unclosed fence to EOF", () => {
    const doc = "ok.\n\n```js\nlet x = 1;";
    const md = maskDocument(doc);
    expect(md.protections).toHaveLength(1);
    expect(md.masked.endsWith("⟦C1⟧")).toBe(true);
  });

  it("protects inline code, including double-backtick spans", () => {
    const doc = "Use `nmap -sV` and `` a `tick` inside `` now.";
    const md = maskDocument(doc);
    const inline = md.protections.filter((p) => p.kind === "inline-code");
    expect(inline).toHaveLength(2);
    expect(inline[0]!.text).toBe("`nmap -sV`");
    expect(inline[1]!.text).toBe("`` a `tick` inside ``");
    expect(md.masked).not.toContain("nmap");
  });

  it("protects bare URLs and autolinks, but keeps link text as prose", () => {
    const doc = "See https://example.com/a?b=1 and <https://cve.org> and [the guide](https://example.com/x).";
    const md = maskDocument(doc);
    const urls = md.protections.filter((p) => p.kind === "url").map((p) => p.text);
    expect(urls).toContain("https://example.com/a?b=1");
    expect(urls).toContain("<https://cve.org>");
    expect(urls).toContain("https://example.com/x");
    expect(md.masked).toContain("[the guide](⟦");
    expect(md.masked).not.toMatch(/https?:\/\/example/);
  });

  it("protects raw HTML tags and comments", () => {
    const doc = "<div class=\"x\">text</div>\n\n<!-- note: <tag> -->\n\nend.";
    const md = maskDocument(doc);
    const html = md.protections.filter((p) => p.kind === "html").map((p) => p.text);
    expect(html).toContain("<div class=\"x\">");
    expect(html).toContain("</div>");
    expect(html).toContain("<!-- note: <tag> -->");
  });

  it("extracts the title from the first heading when no frontmatter", () => {
    const doc = "# Recon Notes\n\nBody.";
    expect(maskDocument(doc).title).toBe("Recon Notes");
  });

  it("placeholders are opaque: no code leaks into the masked doc", () => {
    const doc = `---\ntitle: T\n---\n# H\n\nRun \`rm -rf /\` on https://evil.example/x.\n\n\`\`\`\nsecret()\n\`\`\``;
    const md = maskDocument(doc);
    for (const forbidden of ["secret()", "rm -rf", "evil.example", "title: T"]) {
      expect(md.masked).not.toContain(forbidden);
    }
    for (const ph of phs(doc)) expect(PLACEHOLDER_RE.test(ph)).toBe(true);
    // Restoring: masked + protection texts reassemble the original.
    let restored = md.masked;
    for (const p of md.protections) restored = restored.split(`⟦${p.ph}⟧`).join(p.text);
    expect(restored).toBe(doc);
  });

  it("intersectsProtection detects ranges touching a code fence", () => {
    const doc = "a\n\n```\ncode\n```\n\nb";
    const md = maskDocument(doc);
    const code = md.protections.find((p) => p.kind === "code")!;
    expect(intersectsProtection(md, code.start, code.start + 2)).toBe(true);
    expect(intersectsProtection(md, code.end, doc.length)).toBe(false);
  });

  it("sentences from prose get correct line numbers", () => {
    const doc = [
      "# Title line",
      "",
      "First sentence here. Second sentence follows.",
      "",
      "```",
      "code()",
      "```",
      "",
      "Third after the code block.",
    ].join("\n");
    const sentences = splitSentences(maskDocument(doc));
    const lines = sentences.map((s) => [s.line, s.text]);
    expect(lines).toEqual([
      [1, "# Title line"],
      [3, "First sentence here."],
      [3, "Second sentence follows."],
      [9, "Third after the code block."],
    ]);
  });
});
