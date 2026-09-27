import { describe, expect, it } from "vitest";
import { isDue, newSrsState, schedule, todayIso } from "../src/vocab/srs.js";

const NOW = new Date("2026-09-27T10:00:00");
const DAY = "2026-09-27";
const PLUS = (n: number) => {
  const d = new Date(2026, 8, 27);
  d.setDate(d.getDate() + n);
  return todayIso(d);
};

describe("SM-2 scheduling", () => {
  it("new cards start at ease 2.5, due immediately", () => {
    const s = newSrsState(NOW);
    expect(s).toEqual({ ease: 2.5, intervalDays: 0, repetitions: 0, dueDate: DAY });
    expect(isDue(s, NOW)).toBe(true);
  });

  it("good on a new card → 1 day interval, rep 1", () => {
    const s = schedule(newSrsState(NOW), "good", NOW);
    expect(s.intervalDays).toBe(1);
    expect(s.repetitions).toBe(1);
    expect(s.ease).toBe(2.5);
    expect(s.dueDate).toBe(PLUS(1));
  });

  it("good, good → 1 day then 6 days", () => {
    let s = newSrsState(NOW);
    s = schedule(s, "good", NOW);
    expect(s.intervalDays).toBe(1);
    s = schedule(s, "good", NOW);
    expect(s.intervalDays).toBe(6);
    expect(s.repetitions).toBe(2);
  });

  it("good ×3 → interval multiplies by ease (6 → 15)", () => {
    let s = newSrsState(NOW);
    s = schedule(s, "good", NOW);
    s = schedule(s, "good", NOW);
    s = schedule(s, "good", NOW);
    expect(s.intervalDays).toBe(15);
  });

  it("easy grows ease by 0.15 and boosts intervals", () => {
    let s = schedule(newSrsState(NOW), "easy", NOW);
    expect(s.ease).toBeCloseTo(2.65);
    expect(s.intervalDays).toBe(3);
    // second interval is the classic fixed 6 regardless of the first rating
    s = schedule(s, "good", NOW);
    expect(s.intervalDays).toBe(6);
    s = schedule(s, "good", NOW);
    expect(s.intervalDays).toBe(Math.round(6 * 2.65));
  });

  it("hard shrinks ease by 0.15 and uses a 1.2× interval", () => {
    let s = schedule(newSrsState(NOW), "good", NOW); // 1d, ease 2.5
    s = schedule(s, "good", NOW); // 6d
    s = schedule(s, "hard", NOW);
    expect(s.ease).toBeCloseTo(2.35);
    expect(s.intervalDays).toBe(Math.round(6 * 1.2));
  });

  it("again is a lapse: reset repetitions, due today, ease −0.2 (floor 1.3)", () => {
    let s = schedule(newSrsState(NOW), "good", NOW);
    s = schedule(s, "good", NOW);
    const lapsed = schedule(s, "again", NOW);
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.intervalDays).toBe(0);
    expect(lapsed.dueDate).toBe(DAY);
    expect(lapsed.ease).toBeCloseTo(2.3);
    expect(isDue(lapsed, NOW)).toBe(true);

    let floor = { ease: 1.35, intervalDays: 10, repetitions: 4, dueDate: DAY } as const;
    floor = schedule(floor, "again", NOW);
    expect(floor.ease).toBe(1.3);
  });

  it("ease never exceeds 3.0", () => {
    let s = newSrsState(NOW);
    for (let i = 0; i < 10; i++) s = schedule(s, "easy", NOW);
    expect(s.ease).toBeLessThanOrEqual(3.0);
  });

  it("dueDate comparisons are date-based", () => {
    const s = schedule(newSrsState(NOW), "good", NOW);
    expect(isDue(s, NOW)).toBe(false);
    expect(isDue(s, new Date("2026-09-28T00:01:00"))).toBe(true);
  });
});
