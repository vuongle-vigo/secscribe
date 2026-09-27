/**
 * Append-only history — spec §10. Records: {ts, file, sentenceHash,
 * suggestionId, action} with action ∈ {seen, copied, dismissed, applied,
 * practiced-correct, practiced-partial, practiced-wrong}.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type HistoryAction =
  | "seen"
  | "copied"
  | "dismissed"
  | "applied"
  | "practiced-correct"
  | "practiced-partial"
  | "practiced-wrong";

export interface HistoryRecord {
  ts: string;
  file: string;
  sentenceHash: string;
  suggestionId: string;
  action: HistoryAction;
}

export function appendHistory(path: string | null, records: HistoryRecord[]): void {
  if (!path || records.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function readHistory(path: string): HistoryRecord[] {
  if (!existsSync(path)) return [];
  const out: HistoryRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "action" in parsed) out.push(parsed as HistoryRecord);
    } catch {
      // append-only file: skip corrupt lines
    }
  }
  return out;
}
