/** `secscribe cards list | add <term> | due` (spec §8). */
import pc from "picocolors";
import { VocabularyStore, todayIso } from "@secscribe/core";
import type { CliContext } from "../context.js";

function dueLabel(store: VocabularyStore): (term: string) => string {
  const today = todayIso();
  return (term: string) => {
    const card = store.find(term);
    if (!card) return "";
    return card.srs.dueDate <= today ? pc.yellow("due") : pc.gray(card.srs.dueDate);
  };
}

export function runCards(ctx: CliContext, sub: string, termArg?: string): void {
  const store = new VocabularyStore(ctx.paths.vocabulary);
  if (sub === "add") {
    if (!termArg) {
      console.error(pc.red("usage: secscribe cards add <term>"));
      process.exitCode = 1;
      return;
    }
    const { card, created } = store.add({ term: termArg });
    store.save();
    console.log(created ? pc.green(`✓ added “${card.term}”`) : pc.gray(`• already known — merged sources into “${card.term}”`));
    return;
  }

  const cards = sub === "due" ? store.dueCards() : store.all();
  if (sub !== "list" && sub !== "due") {
    console.error(pc.red(`unknown subcommand “${sub}” — use list | add | due`));
    process.exitCode = 1;
    return;
  }
  const label = dueLabel(store);
  if (cards.length === 0) {
    console.log(sub === "due" ? pc.gray("no cards due 🎉") : pc.gray("no cards yet — add some with `secscribe cards add <term>`"));
    return;
  }
  console.log(pc.bold(sub === "due" ? "Due cards:" : "All cards:"));
  for (const card of cards) {
    const tags = card.tags.length ? pc.gray(`  [${card.tags.join(", ")}]`) : "";
    console.log(`  ${pc.bold(card.term)}  ${label(card.term)}  rep ${card.srs.repetitions} · ease ${card.srs.ease.toFixed(2)}${tags}`);
  }
  console.log(pc.gray(`\n${cards.length} card(s) · ${store.dueCards().length} due`));
}
