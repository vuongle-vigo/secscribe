/** `secscribe export anki --out deck.csv` (spec §8). */
import pc from "picocolors";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { VocabularyStore, toAnkiCsv } from "@secscribe/core";
import type { CliContext } from "../context.js";

export function runExportAnki(ctx: CliContext, outArg: string): void {
  const store = new VocabularyStore(ctx.paths.vocabulary);
  const cards = store.all();
  if (cards.length === 0) {
    console.log(pc.gray("no cards to export"));
    process.exitCode = 1;
    return;
  }
  const out = isAbsolute(outArg) ? outArg : `${process.cwd()}/${outArg}`;
  const csv = toAnkiCsv(cards);
  writeFileSync(out, csv, "utf8");
  console.log(pc.green(`✓ wrote ${out} — ${cards.length} card(s)`));
  console.log(pc.gray("Anki: File → Import, fields: front, back, tags"));
}
