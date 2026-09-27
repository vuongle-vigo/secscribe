/**
 * Reviewed-sentence cache — spec §6.6. Key = hash(sentence + model +
 * prompt-version) stored in `.secscribe/cache.json`; unchanged sentences are
 * never re-sent. Entries also carry token usage so `secscribe status` can
 * report estimated tokens for the last 7 days.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RawSuggestion, RawVocabulary } from "./schema.js";

export interface CacheEntry {
  /** ISO timestamp of the review. */
  t: string;
  model: string;
  usage: { p: number; c: number } | null;
  /** Character count of the sentence, for token estimation when usage is absent. */
  chars: number;
  suggestions: RawSuggestion[];
  vocabulary: RawVocabulary[];
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export function cacheKey(sentence: string, model: string, promptVersion: string): string {
  return createHash("sha256").update(`${sentence}\u0000${model}\u0000${promptVersion}`).digest("hex").slice(0, 24);
}

export class ReviewCache {
  private file: CacheFile = { version: 1, entries: {} };
  private loaded = false;
  hits = 0;
  misses = 0;

  constructor(private readonly path: string | null) {}

  load(): void {
    if (this.loaded || !this.path) return;
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8"));
        if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
          this.file = { version: 1, entries: raw.entries as Record<string, CacheEntry> };
        }
      } catch {
        this.file = { version: 1, entries: {} };
      }
    }
    this.loaded = true;
  }

  get(key: string): CacheEntry | null {
    this.load();
    const entry = this.file.entries[key] ?? null;
    if (entry) this.hits++;
    else this.misses++;
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.load();
    this.file.entries[key] = entry;
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2));
  }

  allEntries(): Record<string, CacheEntry> {
    this.load();
    return this.file.entries;
  }

  /** Estimated + reported token usage over the last `days` days. */
  usageLastDays(days: number, now = new Date()): { promptTokens: number; completionTokens: number; requests: number } {
    const cutoff = now.getTime() - days * 24 * 3600 * 1000;
    let p = 0;
    let c = 0;
    let requests = 0;
    for (const entry of Object.values(this.allEntries())) {
      const ts = Date.parse(entry.t);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      requests++;
      if (entry.usage) {
        p += entry.usage.p;
        c += entry.usage.c;
      } else {
        p += Math.ceil(entry.chars / 4);
        c += 64;
      }
    }
    return { promptTokens: p, completionTokens: c, requests };
  }
}
