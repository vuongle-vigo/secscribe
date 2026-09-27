import { describe, expect, it } from "vitest";
import { applyEdits, findQuote } from "../src/markdown/apply.js";

describe("quote matching (spec §6.5)", () => {
  it("unique match → applicable", () => {
    const m = findQuote("aaa unique bbb", "unique");
    expect(m.status).toBe("applicable");
    expect(m.offsets).toEqual([4]);
  });

  it("multiple matches → ambiguous with all offsets", () => {
    const m = findQuote("x y x y x", "x");
    expect(m.status).toBe("ambiguous");
    expect(m.offsets).toEqual([0, 4, 8]);
  });

  it("zero matches → stale, never guess", () => {
    const m = findQuote("nothing here", "absent");
    expect(m.status).toBe("stale");
    expect(m.offsets).toEqual([]);
  });
});

describe("applyEdits", () => {
  it("applies a unique replacement exactly", () => {
    const r = applyEdits("keep this keep", [{ quote: "this", replacement: "THAT" }]);
    expect(r.text).toBe("keep THAT keep");
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it("applies a chosen occurrence for ambiguous quotes", () => {
    const r = applyEdits("one two one two", [
      { quote: "one", replacement: "1", occurrence: 1 },
    ]);
    expect(r.text).toBe("one two 1 two");
  });

  it("skips stale edits untouched", () => {
    const r = applyEdits("stable", [{ quote: "missing", replacement: "x" }]);
    expect(r.text).toBe("stable");
    expect(r.skipped[0]!.reason).toBe("stale");
  });

  it("applies multiple edits without offset corruption", () => {
    const r = applyEdits("a b c d e", [
      { quote: "b", replacement: "B" },
      { quote: "d", replacement: "D" },
    ]);
    expect(r.text).toBe("a B c D e");
  });

  it("overlapping quotes: the earlier edit wins, the clobbered one is skipped, never guessed", () => {
    const r = applyEdits("abc", [
      { quote: "ab", replacement: "X" },
      { quote: "bc", replacement: "Y" },
    ]);
    expect(r.text).toBe("Xc");
    expect(r.applied).toHaveLength(1);
    expect(r.skipped[0]!.reason).toBe("overwritten-by-earlier-edit");
  });
});
