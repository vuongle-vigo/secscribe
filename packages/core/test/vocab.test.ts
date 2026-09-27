import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VocabularyStore } from "../src/vocab/cards.js";
import { makeCloze } from "../src/vocab/cloze.js";
import type { VocabularyExtract } from "../src/review/engine.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "secscribe-vocab-"));
  return { store: new VocabularyStore(join(dir, "vocabulary.json")), dir };
}

function extract(over: Partial<VocabularyExtract> = {}): VocabularyExtract {
  return {
    term: "reconnaissance",
    phonetic: "/rɪˈkɒnɪsəns/",
    definitionEn: "Exploring a target to gather information.",
    definitionVi: "Trinh sát mục tiêu để thu thập thông tin.",
    example: "We performed reconnaissance before the attack.",
    synonyms: ["recon"],
    tags: ["security"],
    sentenceHash: "abc",
    line: 3,
    ...over,
  };
}

describe("vocabulary store", () => {
  it("adding the same term twice yields one card with two sources (acceptance #3)", () => {
    const { store } = tempStore();
    store.addFromExtract(extract(), "posts/a.md");
    store.addFromExtract(
      extract({ example: "Reconnaissance is the first phase.", definitionEn: "" }),
      "posts/b.md",
    );
    store.save();
    const cards = store.all();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.sources).toHaveLength(2);
    expect(card.sources.map((s) => s.file)).toEqual(["posts/a.md", "posts/b.md"]);
    // existing definition is kept, not overwritten by the empty one
    expect(card.definition_en).toBe("Exploring a target to gather information.");
  });

  it("uniqueness is case-insensitive", () => {
    const { store } = tempStore();
    store.add({ term: "Payload" });
    store.add({ term: "payload", source: { file: "x.md", quote: "the payload" } });
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.sources).toHaveLength(1);
  });

  it("caps sources at 3, dedupes identical quotes", () => {
    const { store } = tempStore();
    store.add({ term: "t", source: { file: "a", quote: "q1" } });
    store.add({ term: "t", source: { file: "a", quote: "q1" } });
    store.add({ term: "t", source: { file: "b", quote: "q2" } });
    store.add({ term: "t", source: { file: "c", quote: "q3" } });
    store.add({ term: "t", source: { file: "d", quote: "q4" } });
    const card = store.all()[0]!;
    expect(card.sources).toHaveLength(3);
  });

  it("persists across restarts and SRS state advances (acceptance #4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "secscribe-vocab-"));
    const path = join(dir, "vocabulary.json");
    const first = new VocabularyStore(path);
    first.add({ term: "hardening" });
    const card = first.all()[0]!;
    first.review(card.id, "good");
    first.save();

    const second = new VocabularyStore(path);
    const reloaded = second.all()[0]!;
    expect(reloaded.srs.repetitions).toBe(1);
    expect(reloaded.stats.lastReview).not.toBeNull();
    expect(second.dueCards()).toHaveLength(0);
  });

  it("review counts new/review cards per day and studyQueue respects caps", () => {
    const { store } = tempStore();
    for (const t of ["a", "b", "c", "d"]) store.add({ term: t });
    const old = store.all()[0]!;
    store.review(old.id, "good"); // a: now rep 1, due tomorrow

    // 3 fresh cards due today; card "a" already used one new slot, so a cap of
    // 3 leaves 2 more fresh cards in the queue.
    const queue = store.studyQueue(new Date(), { newPerDay: 3, reviewsPerDay: 50 });
    expect(queue.map((c) => c.term).sort()).toEqual(["b", "c"]);
    expect(store.dailyCounters()).toEqual({ new: 1, reviews: 1 });

    // reviewsPerDay cap of 1 (already used) → empty queue
    expect(store.studyQueue(new Date(), { newPerDay: 10, reviewsPerDay: 1 })).toHaveLength(0);
  });

  it("delete removes a card", () => {
    const { store } = tempStore();
    store.add({ term: "xss" });
    expect(store.delete("XSS")).toBe(true);
    expect(store.all()).toHaveLength(0);
  });

  it("card record matches the spec §7 shape", () => {
    const { store, dir } = tempStore();
    store.addFromExtract(extract(), "posts/a.md");
    store.save();
    const raw = JSON.parse(readFileSync(join(dir, "vocabulary.json"), "utf8"));
    const card = raw.cards[0];
    expect(card.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(card.srs).toMatchObject({ ease: 2.5, intervalDays: 0, repetitions: 0 });
    expect(card.srs.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(card.stats).toEqual({ lapses: 0, lastReview: null });
    expect(card.sources[0]).toEqual({ file: "posts/a.md", quote: "We performed reconnaissance before the attack." });
  });
});

describe("cloze generation", () => {
  it("blanks the term in the user's own sentence", () => {
    const { front, found } = makeCloze("We performed reconnaissance before the attack.", "reconnaissance");
    expect(found).toBe(true);
    expect(front).toBe("We performed ______ before the attack.");
  });

  it("matches case-insensitively but only whole words", () => {
    expect(makeCloze("The Reconnaissance phase", "reconnaissance").front).toBe("The ______ phase");
    expect(makeCloze("they were there", "the").found).toBe(false);
    expect(makeCloze("scanning and rescanning", "scanning").front).toBe("______ and rescanning");
  });

  it("multi-word terms work", () => {
    expect(makeCloze("we did threat modeling early", "threat modeling").front).toBe("we did ______ early");
  });
});
