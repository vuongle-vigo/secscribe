/** `secscribe status` — due counts, total cards, estimated tokens last 7 days (spec §8). */
import pc from "picocolors";
import { ReviewCache, VocabularyStore } from "@secscribe/core";
import type { CliContext } from "../context.js";

export function runStatus(ctx: CliContext): void {
  const store = new VocabularyStore(ctx.paths.vocabulary);
  const cache = new ReviewCache(ctx.paths.cache);
  const due = store.dueCards().length;
  const total = store.all().length;
  const usage = cache.usageLastDays(7);
  const daily = store.dailyCounters();

  console.log(pc.bold("SecScribe status"));
  console.log(`  cards: ${total} (${due} due, ${total - due} upcoming)`);
  console.log(`  today: ${daily.reviews} review(s), ${daily.new} new card(s) — limits ${ctx.config.reviewsPerDay}/${ctx.config.newCardsPerDay}`);
  console.log(`  tokens (7d): ~${usage.promptTokens + usage.completionTokens} (prompt ${usage.promptTokens} + completion ${usage.completionTokens}, ${usage.requests} request(s))`);
  if (ctx.config.baseUrl && ctx.config.model) {
    console.log(pc.gray(`  endpoint: ${ctx.config.baseUrl} · model: ${ctx.config.model}`));
  }
}
