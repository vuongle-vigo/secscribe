/** Study session controller: cloze flashcards via the core store (SPEC §9). */
import { makeCloze, normalizeForComparison, type Rating, type Card } from "@secscribe/core";

export interface PanelStudyCard {
  term: string;
  front: string;
  /** Revealed content. */
  termLine: string;
  definitionEn: string;
  definitionVi: string;
  quote: string | null;
  synonyms: string[];
  source: string | null;
}

export interface PanelStudy {
  type: "study";
  state: "idle" | "question" | "revealed" | "summary";
  index: number;
  total: number;
  card: PanelStudyCard | null;
  counts: { again: number; hard: number; good: number; easy: number };
  remainingDue: number;
  /** Present when the card was revealed by typing an answer into the blank:
   *  the typed text and whether it matches the term (normalized compare). */
  answer: { text: string; correct: boolean } | null;
}

interface Session {
  queue: Card[];
  index: number;
  revealed: boolean;
  counts: PanelStudy["counts"];
  answer: { text: string; correct: boolean } | null;
}

export class StudyController {
  private session: Session | null = null;
  /** Counts of the last finished session — shown until the next start. */
  private lastSummary: PanelStudy["counts"] | null = null;

  constructor(
    private readonly vocab: { raw(): import("@secscribe/core").VocabularyStore; dueCount(): number },
    private readonly limits: () => { newPerDay: number; reviewsPerDay: number },
  ) {}

  start(): PanelStudy {
    const queue = this.vocab.raw().studyQueue(new Date(), this.limits());
    this.lastSummary = null;
    this.session = queue.length
      ? { queue, index: 0, revealed: false, counts: { again: 0, hard: 0, good: 0, easy: 0 }, answer: null }
      : null;
    return this.payload();
  }

  reveal(): PanelStudy {
    if (this.session && !this.session.revealed) this.session.revealed = true;
    return this.payload();
  }

  /** Typed answer: normalize (case/punctuation/whitespace), reveal with a verdict. */
  answer(text: string): PanelStudy {
    if (!this.session || this.session.revealed) return this.payload();
    const card = this.session.queue[this.session.index];
    if (!card) return this.payload();
    const correct = normalizeForComparison(text) === normalizeForComparison(card.term);
    this.session.answer = { text: text.trim(), correct };
    this.session.revealed = true;
    return this.payload();
  }

  rate(rating: Rating): PanelStudy {
    if (!this.session) return this.payload();
    const card = this.session.queue[this.session.index];
    if (card) {
      this.vocab.raw().review(card.id, rating);
      this.vocab.raw().save();
      this.session.counts[rating] += 1;
    }
    this.session.revealed = false;
    this.session.answer = null;
    this.session.index += 1;
    if (this.session.index >= this.session.queue.length) {
      this.lastSummary = this.session.counts;
      this.session = null;
    }
    return this.payload();
  }

  active(): boolean {
    return this.session !== null;
  }

  payload(): PanelStudy {
    if (!this.session) {
      if (this.lastSummary) {
        return {
          type: "study",
          state: "summary",
          index: 0,
          total: 0,
          card: null,
          counts: this.lastSummary,
          remainingDue: this.vocab.dueCount(),
          answer: null,
        };
      }
      return {
        type: "study",
        state: "idle",
        index: 0,
        total: 0,
        card: null,
        counts: { again: 0, hard: 0, good: 0, easy: 0 },
        remainingDue: this.vocab.dueCount(),
        answer: null,
      };
    }
    const card = this.session.queue[this.session.index]!;
    return {
      type: "study",
      state: this.session.revealed ? "revealed" : "question",
      index: this.session.index,
      total: this.session.queue.length,
      card: toPanelCard(card),
      counts: this.session.counts,
      remainingDue: this.vocab.dueCount(),
      // Only a typed answer carries a verdict; plain reveals have none.
      answer: this.session.revealed ? this.session.answer : null,
    };
  }
}

function toPanelCard(card: Card): PanelStudyCard {
  const source = card.sources[0];
  let front = card.definition_en ? `What does “${card.term}” mean?` : card.term;
  if (source?.quote) {
    const cloze = makeCloze(source.quote, card.term);
    if (cloze.found) front = cloze.front;
  }
  return {
    term: card.term,
    front,
    termLine: card.term + (card.phonetic ? ` ${card.phonetic}` : ""),
    definitionEn: card.definition_en,
    definitionVi: card.definition_vi,
    quote: source?.quote ?? null,
    synonyms: card.synonyms,
    source: source?.file ?? null,
  };
}
