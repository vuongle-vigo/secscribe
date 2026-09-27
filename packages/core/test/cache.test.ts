import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewCache, cacheKey } from "../src/review/cache.js";

describe("review cache (spec §6.6)", () => {
  it("key includes sentence, model, and prompt version", () => {
    const base = cacheKey("sentence", "model-a", "pv1");
    expect(cacheKey("sentence", "model-b", "pv1")).not.toBe(base);
    expect(cacheKey("sentence", "model-a", "pv2")).not.toBe(base);
    expect(cacheKey("other", "model-a", "pv1")).not.toBe(base);
    expect(cacheKey("sentence", "model-a", "pv1")).toBe(base);
  });

  it("persists entries across instances (unchanged sentences are never re-sent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "secscribe-cache-"));
    const path = join(dir, "cache.json");
    const a = new ReviewCache(path);
    a.set("k1", { t: new Date().toISOString(), model: "m", usage: { p: 10, c: 5 }, chars: 40, suggestions: [], vocabulary: [] });
    a.save();
    expect(existsSync(path)).toBe(true);

    const b = new ReviewCache(path);
    expect(b.get("k1")?.usage).toEqual({ p: 10, c: 5 });
    expect(b.hits).toBe(1);
    expect(b.get("missing")).toBeNull();
  });

  it("usageLastDays only counts recent entries and estimates when usage absent", () => {
    const cache = new ReviewCache(null);
    const now = new Date("2026-09-27T12:00:00");
    const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600 * 1000).toISOString();
    cache.set("recent", { t: daysAgo(2), model: "m", usage: { p: 100, c: 50 }, chars: 10, suggestions: [], vocabulary: [] });
    cache.set("old", { t: daysAgo(9), model: "m", usage: { p: 999, c: 999 }, chars: 10, suggestions: [], vocabulary: [] });
    cache.set("estimated", { t: daysAgo(1), model: "m", usage: null, chars: 400, suggestions: [], vocabulary: [] });
    const usage = cache.usageLastDays(7, now);
    expect(usage.requests).toBe(2);
    expect(usage.promptTokens).toBe(100 + 100); // 100 reported + ceil(400/4) estimated
    expect(usage.completionTokens).toBe(50 + 64);
  });

  it("cache file shape is JSON with version and entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "secscribe-cache-"));
    const path = join(dir, "cache.json");
    const a = new ReviewCache(path);
    a.set("k", { t: "2026-09-27T00:00:00Z", model: "m", usage: null, chars: 5, suggestions: [], vocabulary: [] });
    a.save();
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.entries)).toEqual(["k"]);
  });
});
