import { describe, expect, it } from "vitest";
import { gradeFix, normalizeForComparison, wordDiff } from "../src/markdown/diff.js";

describe("wordDiff", () => {
  it("marks single word changes", () => {
    const ops = wordDiff("the attacker use a payload", "the attacker used a payload");
    const del = ops.find((o) => o.type === "del");
    const ins = ops.find((o) => o.type === "ins");
    expect(del?.text).toBe("use");
    expect(ins?.text).toBe("used");
    const same = ops.filter((o) => o.type === "same").map((o) => o.text);
    expect(same.join(" ")).toBe("the attacker a payload");
  });

  it("handles full replacement", () => {
    const ops = wordDiff("aa bb", "cc dd");
    expect(ops.filter((o) => o.type === "del").map((o) => o.text).join(" ")).toBe("aa bb");
    expect(ops.filter((o) => o.type === "ins").map((o) => o.text).join(" ")).toBe("cc dd");
  });
});

describe("practice-mode normalization (acceptance #9)", () => {
  it("ignores case, whitespace, and punctuation", () => {
    expect(normalizeForComparison("The attacker used  a payload!")).toBe(
      normalizeForComparison("the attacker used a  payload"),
    );
  });

  it("keeps placeholders intact", () => {
    expect(normalizeForComparison("run ⟦C1⟧ now")).toBe("run ⟦c1⟧ now");
    expect(normalizeForComparison("run ⟦C1⟧ now")).not.toBe("run c1 now");
  });

  it("correct on normalized equality", () => {
    expect(gradeFix("The payload was Delivered.", "the payload was delivered").verdict).toBe("correct");
  });

  it("partial on mostly-right answers", () => {
    const r = gradeFix("the payload is delivered yesterday", "the payload was delivered");
    expect(r.verdict).toBe("partial");
  });

  it("incorrect on unrelated answers", () => {
    expect(gradeFix("chicken rice coffee", "the payload was delivered").verdict).toBe("incorrect");
  });

  it("empty input is incorrect", () => {
    expect(gradeFix("", "anything").verdict).toBe("incorrect");
    expect(gradeFix("!!!", "anything").verdict).toBe("incorrect");
  });
});
