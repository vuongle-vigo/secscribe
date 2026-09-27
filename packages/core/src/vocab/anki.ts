/**
 * Anki CSV export — spec §8. Columns: front (cloze sentence), back (term +
 * definitions + synonyms + source), tags. Fields are HTML; quotes are escaped
 * by doubling; fields containing comma/quote/newline are quoted.
 */
import type { Card } from "./cards.js";
import { makeCloze } from "./cloze.js";

export function csvField(value: string): string {
  const needsQuotes = /[",\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/** Multi-line content becomes <br> so cards stay single-line CSV records. */
function html(s: string): string {
  return s.replace(/\r?\n/g, "<br>");
}

export function cardFront(card: Card): string {
  const source = card.sources[0];
  if (source && source.quote) {
    const { front, found } = makeCloze(source.quote, card.term);
    if (found) return front;
  }
  // No usable example sentence — fall back to definition prompt.
  return card.definition_en ? `What does “${card.term}” mean?` : card.term;
}

export function cardBack(card: Card): string {
  const lines: string[] = [];
  lines.push(`**${card.term}**${card.phonetic ? ` ${card.phonetic}` : ""}`);
  if (card.definition_en) lines.push(card.definition_en);
  if (card.definition_vi) lines.push(card.definition_vi);
  if (card.synonyms.length) lines.push(`Synonyms: ${card.synonyms.join(", ")}`);
  const source = card.sources[0];
  if (source) lines.push(`Source: ${source.file} — “${html(source.quote)}”`);
  return lines.join("<br>");
}

export function toAnkiCsv(cards: Card[]): string {
  const rows = cards.map((card) => {
    const tags = [...card.tags.map((t) => t.replace(/\s+/g, "_")), "secscribe"].join(" ");
    return [csvField(html(cardFront(card))), csvField(html(cardBack(card))), csvField(tags)].join(",");
  });
  return rows.join("\n") + (rows.length ? "\n" : "");
}
