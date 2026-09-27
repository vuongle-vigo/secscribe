/**
 * Vocabulary store — spec §7/§10. Cards live in `.secscribe/vocabulary.json`,
 * unique by lowercase `term`; adding a duplicate merges sources (max 3 quotes
 * per card). Daily new/review counters cap study sessions.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { VocabularyExtract } from "../review/engine.js";
import { isDue, newSrsState, schedule, todayIso, type Rating, type SrsState, type SrsStats } from "./srs.js";

export interface CardSource {
  file: string;
  quote: string;
}

export interface Card {
  id: string;
  term: string;
  phonetic: string;
  definition_en: string;
  definition_vi: string;
  synonyms: string[];
  tags: string[];
  sources: CardSource[];
  srs: SrsState;
  stats: SrsStats;
  createdAt: string;
}

export interface VocabFile {
  version: 1;
  cards: Card[];
  /** Per-day counters for newCardsPerDay / reviewsPerDay caps. */
  daily: Record<string, { new: number; reviews: number }>;
}

export interface AddCardInput {
  term: string;
  phonetic?: string;
  definition_en?: string;
  definition_vi?: string;
  synonyms?: string[];
  tags?: string[];
  source?: CardSource;
}

const MAX_SOURCES = 3;

export class VocabularyStore {
  private file: VocabFile = { version: 1, cards: [], daily: {} };
  private loaded = false;

  constructor(private readonly path: string | null) {}

  load(): void {
    if (this.loaded || !this.path) return;
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8"));
        if (raw && Array.isArray(raw.cards)) {
          this.file = {
            version: 1,
            cards: raw.cards as Card[],
            daily: raw.daily && typeof raw.daily === "object" ? raw.daily : {},
          };
        }
      } catch {
        this.file = { version: 1, cards: [], daily: {} };
      }
    }
    this.loaded = true;
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2));
  }

  all(): Card[] {
    this.load();
    return [...this.file.cards].sort((a, b) => a.term.localeCompare(b.term));
  }

  find(term: string): Card | null {
    this.load();
    const lower = term.toLowerCase();
    return this.file.cards.find((c) => c.term.toLowerCase() === lower) ?? null;
  }

  dueCards(now: Date = new Date()): Card[] {
    return this.all().filter((c) => isDue(c.srs, now));
  }

  /**
   * Add a term, or merge into the existing card when the lowercase term
   * already exists. Existing card fields win; only empty fields are filled.
   * Sources are deduped by (file, quote), capped at MAX_SOURCES.
   */
  add(input: AddCardInput): { card: Card; created: boolean } {
    this.load();
    const term = input.term.trim();
    if (!term) throw new Error("term must not be empty");
    const existing = this.find(term);
    if (existing) {
      existing.phonetic ||= input.phonetic?.trim() ?? "";
      existing.definition_en ||= input.definition_en?.trim() ?? "";
      existing.definition_vi ||= input.definition_vi?.trim() ?? "";
      const synonyms = new Set(existing.synonyms);
      for (const s of input.synonyms ?? []) synonyms.add(s);
      existing.synonyms = [...synonyms];
      const tags = new Set(existing.tags);
      for (const t of input.tags ?? []) tags.add(t);
      existing.tags = [...tags];
      if (input.source) {
        const seen = new Set(existing.sources.map((s) => `${s.file}\u0000${s.quote}`));
        if (!seen.has(`${input.source.file}\u0000${input.source.quote}`)) {
          existing.sources.push(input.source);
          existing.sources.sort((a, b) => a.file.localeCompare(b.file) || a.quote.localeCompare(b.quote));
          if (existing.sources.length > MAX_SOURCES) {
            existing.sources = existing.sources.slice(0, MAX_SOURCES);
          }
        }
      }
      return { card: existing, created: false };
    }
    const card: Card = {
      id: randomUUID(),
      term,
      phonetic: input.phonetic?.trim() ?? "",
      definition_en: input.definition_en?.trim() ?? "",
      definition_vi: input.definition_vi?.trim() ?? "",
      synonyms: [...new Set(input.synonyms ?? [])],
      tags: [...new Set(input.tags ?? [])],
      sources: input.source ? [input.source] : [],
      srs: newSrsState(),
      stats: { lapses: 0, lastReview: null },
      createdAt: new Date().toISOString(),
    };
    this.file.cards.push(card);
    return { card, created: true };
  }

  addFromExtract(extract: VocabularyExtract, file: string): { card: Card; created: boolean } {
    return this.add({
      term: extract.term,
      phonetic: extract.phonetic,
      definition_en: extract.definitionEn,
      definition_vi: extract.definitionVi,
      synonyms: extract.synonyms,
      tags: extract.tags,
      source: { file, quote: extract.example },
    });
  }

  delete(term: string): boolean {
    this.load();
    const lower = term.toLowerCase();
    const idx = this.file.cards.findIndex((c) => c.term.toLowerCase() === lower);
    if (idx === -1) return false;
    this.file.cards.splice(idx, 1);
    return true;
  }

  /** Record a review: advance SRS state, update stats and daily counters. */
  review(cardId: string, rating: Rating, now: Date = new Date()): Card | null {
    this.load();
    const card = this.file.cards.find((c) => c.id === cardId);
    if (!card) return null;
    card.srs = schedule(card.srs, rating, now);
    card.stats.lastReview = now.toISOString();
    if (rating === "again") card.stats.lapses += 1;
    const day = todayIso(now);
    const counters = (this.file.daily[day] ??= { new: 0, reviews: 0 });
    counters.reviews += 1;
    if (card.srs.repetitions === 1 && rating !== "again") counters.new += 1;
    return card;
  }

  /**
   * Cards to study today: due cards, capped by reviewsPerDay, of which
   * never-studied (repetitions === 0) cards are capped by newCardsPerDay.
   */
  studyQueue(now: Date = new Date(), limits: { newPerDay: number; reviewsPerDay: number }): Card[] {
    this.load();
    const day = todayIso(now);
    const counters = this.file.daily[day] ?? { new: 0, reviews: 0 };
    const due = this.dueCards(now);
    const reviewBudget = Math.max(0, limits.reviewsPerDay - counters.reviews);
    const newBudget = Math.max(0, limits.newPerDay - counters.new);
    const fresh: Card[] = [];
    const old: Card[] = [];
    for (const c of due) (c.srs.repetitions === 0 ? fresh : old).push(c);
    return [...fresh.slice(0, newBudget), ...old].slice(0, reviewBudget);
  }

  dailyCounters(now: Date = new Date()): { new: number; reviews: number } {
    this.load();
    return this.file.daily[todayIso(now)] ?? { new: 0, reviews: 0 };
  }
}

export function cardKey(card: Card): string {
  return createHash("sha256").update(card.term.toLowerCase()).digest("hex").slice(0, 12);
}
