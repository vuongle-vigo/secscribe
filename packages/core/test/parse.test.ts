import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson, parseReviewResponse } from "../src/review/schema.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("LLM response parsing (contract, spec §6.4)", () => {
  it("parses a valid response exactly matching the schema", () => {
    const r = parseReviewResponse(load("valid-response.json"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.suggestions).toHaveLength(2);
      expect(r.data.suggestions[0]).toMatchObject({
        id: "s1",
        category: "grammar",
        severity: "error",
        reason_vi: expect.stringContaining("quá khứ"),
      });
      expect(r.data.vocabulary[0]!.term).toBe("reconnaissance");
    }
  });

  it("tolerates markdown fences around otherwise-valid JSON", () => {
    const r = parseReviewResponse(load("valid-fenced.json"));
    expect(r.ok).toBe(true);
  });

  it("tolerates leading commentary before the JSON object", () => {
    const r = parseReviewResponse(`Sure! Here is the JSON you asked for:\n${load("valid-response.json")}\nHope this helps.`);
    expect(r.ok).toBe(true);
  });

  it("rejects invalid JSON with a parse issue", () => {
    const r = parseReviewResponse("oops, I cannot do that");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain("not valid JSON");
  });

  it("rejects schema violations (missing reason_vi)", () => {
    const r = parseReviewResponse(load("malformed.json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toContain("reason_vi");
  });

  it("fills optional defaults and strips unknown keys", () => {
    const r = parseReviewResponse(
      JSON.stringify({
        suggestions: [
          {
            id: "x1",
            category: "style",
            severity: "minor",
            original_quote: "a",
            replacement: "b",
            reason_en: "e",
            reason_vi: "v",
            hacker_extra: "ignore me",
          },
        ],
        vocabulary: [{ term: "t" }],
        bonus_field: true,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.suggestions[0]!.alternatives).toEqual([]);
      expect(r.data.vocabulary[0]!.tags).toEqual([]);
      expect((r.data as unknown as Record<string, unknown>)["bonus_field"]).toBeUndefined();
    }
  });

  it("extractJson returns null for text with no object", () => {
    expect(extractJson("no braces here")).toBeNull();
  });
});
