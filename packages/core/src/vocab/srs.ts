/**
 * SM-2 spaced repetition — Anki's classic algorithm (spec §7).
 * Four ratings: Again / Hard / Good / Easy. All state is day-granular.
 * See DECISIONS.md for the exact variant (ease modifiers and interval
 * schedule are Anki's classic defaults).
 */

export type Rating = "again" | "hard" | "good" | "easy";

export interface SrsState {
  ease: number;
  intervalDays: number;
  repetitions: number;
  /** ISO date (YYYY-MM-DD) the card is due. */
  dueDate: string;
}

export interface SrsStats {
  lapses: number;
  lastReview: string | null;
}

export const DEFAULT_EASE = 2.5;

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y!, (m! - 1), d!);
  date.setDate(date.getDate() + days);
  return todayIso(date);
}

const EASE_DELTA: Record<Rating, number> = { again: -0.2, hard: -0.15, good: 0, easy: 0.15 };

export function newSrsState(now: Date = new Date()): SrsState {
  return { ease: DEFAULT_EASE, intervalDays: 0, repetitions: 0, dueDate: todayIso(now) };
}

/** Advance a card's SRS state by one review with the given rating. */
export function schedule(state: SrsState, rating: Rating, now: Date = new Date()): SrsState {
  const today = todayIso(now);
  const ease = Math.min(3.0, Math.max(1.3, state.ease + EASE_DELTA[rating]));

  if (rating === "again") {
    // Lapse: reset repetitions, due again today for re-drilling.
    return { ease, intervalDays: 0, repetitions: 0, dueDate: today };
  }

  let interval: number;
  switch (rating) {
    case "hard":
      interval = state.repetitions === 0 ? 1 : Math.max(1, Math.round(state.intervalDays * 1.2));
      break;
    case "good":
      interval = state.repetitions === 0 ? 1 : state.repetitions === 1 ? 6 : Math.round(state.intervalDays * ease);
      break;
    case "easy":
      interval = state.repetitions === 0 ? 3 : state.repetitions === 1 ? 8 : Math.round(state.intervalDays * ease * 1.3);
      break;
  }
  return {
    ease,
    intervalDays: interval,
    repetitions: state.repetitions + 1,
    dueDate: addDays(today, interval),
  };
}

export function isDue(state: SrsState, now: Date = new Date()): boolean {
  return state.dueDate <= todayIso(now);
}

export function appliesLapse(rating: Rating): boolean {
  return rating === "again";
}
