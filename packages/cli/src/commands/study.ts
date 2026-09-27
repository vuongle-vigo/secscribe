/** `secscribe study` — terminal flashcards: cloze → reveal → rate 1–4 (spec §8). */
import pc from "picocolors";
import { VocabularyStore, makeCloze, todayIso, type Card, type Rating } from "@secscribe/core";
import { askKey } from "../ui/input.js";
import type { CliContext } from "../context.js";

const RATING_KEYS: Record<string, Rating> = { "1": "again", "2": "hard", "3": "good", "4": "easy" };

export async function runStudy(ctx: CliContext): Promise<void> {
  const store = new VocabularyStore(ctx.paths.vocabulary);
  const limits = { newPerDay: ctx.config.newCardsPerDay, reviewsPerDay: ctx.config.reviewsPerDay };
  const queue = store.studyQueue(new Date(), limits);

  if (queue.length === 0) {
    console.log(pc.gray("nothing due today 🎉 (or daily limits reached)"));
    return;
  }

  console.log(pc.bold(`\nStudy session — ${queue.length} card(s) due\n`));
  const counts: Record<Rating, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  let quit = false;

  for (let i = 0; i < queue.length && !quit; i++) {
    const card = queue[i]!;
    console.log(pc.cyan(`[${i + 1}/${queue.length}]`) + pc.gray(`  source: ${card.sources[0]?.file ?? "manual"}`));

    const front = cardFront(card);
    console.log(pc.bold(`  ${front}`));

    const reveal = await askKey("  reveal?", ["", " ", "\n", "q", "y"]);
    // askKey trims to one char; "q" quits, anything else reveals.
    if (reveal === "q") {
      quit = true;
      console.log();
      continue;
    }

    console.log(`  ${pc.green(pc.bold(card.term))}${card.phonetic ? pc.gray(` ${card.phonetic}`) : ""}`);
    if (card.definition_en) console.log(pc.gray(`  EN: ${card.definition_en}`));
    if (card.definition_vi) console.log(pc.gray(`  VI: ${card.definition_vi}`));
    if (card.sources[0]?.quote) console.log(pc.gray(`  “${card.sources[0].quote}”`));
    if (card.synonyms.length) console.log(pc.gray(`  syn: ${card.synonyms.join(", ")}`));

    const key = await askKey("  rate", ["1", "2", "3", "4", "q"], "3");
    if (key === null || key === "q") {
      quit = true;
      console.log();
      continue;
    }
    const rating = RATING_KEYS[key] ?? "good";
    counts[rating]++;
    store.review(card.id, rating);
    console.log(pc.gray(`  → next due ${store.find(card.term)?.srs.dueDate}\n`));
  }

  store.save();
  const total = counts.again + counts.hard + counts.good + counts.easy;
  console.log(pc.bold("\nSession summary"));
  console.log(`  reviewed: ${total}/${queue.length}`);
  console.log(`  again ${counts.again} · hard ${counts.hard} · good ${counts.good} · easy ${counts.easy}`);
  const remaining = store.dueCards().length;
  console.log(pc.gray(`  still due: ${remaining} · today: ${JSON.stringify(store.dailyCounters())} (${todayIso()})`));
}

function cardFront(card: Card): string {
  const source = card.sources[0];
  if (source?.quote) {
    const { front, found } = makeCloze(source.quote, card.term);
    if (found) return front;
  }
  return card.definition_en ? `What does “${card.term}” mean?` : card.term;
}
