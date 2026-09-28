/** `secscribe cards list | add <term> | due | define <term>|--all` (spec §8). */
import pc from "picocolors";
import { LlmClient, VocabularyStore, defineTerm, todayIso } from "@secscribe/core";
import type { CliContext } from "../context.js";
import { ensurePrivacyConfirmed } from "../context.js";

function dueLabel(store: VocabularyStore): (term: string) => string {
  const today = todayIso();
  return (term: string) => {
    const card = store.find(term);
    if (!card) return "";
    return card.srs.dueDate <= today ? pc.yellow("due") : pc.gray(card.srs.dueDate);
  };
}

export async function runCards(ctx: CliContext, sub: string, termArg?: string): Promise<void> {
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
    if (!card.definition_en) {
      console.log(pc.gray(`  no meaning yet — run: secscribe cards define "${card.term}"`));
    }
    return;
  }

  if (sub === "define") {
    await runDefine(ctx, store, termArg);
    return;
  }

  const cards = sub === "due" ? store.dueCards() : store.all();
  if (sub !== "list" && sub !== "due") {
    console.error(pc.red(`unknown subcommand “${sub}” — use list | add | due | define`));
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
    const missing = !card.definition_en ? pc.yellow("  (no meaning)") : "";
    console.log(`  ${pc.bold(card.term)}  ${label(card.term)}  rep ${card.srs.repetitions} · ease ${card.srs.ease.toFixed(2)}${tags}${missing}`);
  }
  console.log(pc.gray(`\n${cards.length} card(s) · ${store.dueCards().length} due`));
}

/** `cards define <term>` / `cards define --all`: backfill bilingual meanings. */
async function runDefine(ctx: CliContext, store: VocabularyStore, termArg?: string): Promise<void> {
  const config = ctx.config;
  if (!config.baseUrl || !config.model || !config.apiKey) {
    console.error(pc.red("cards define needs a configured endpoint — run `secscribe init` or set SECSRIBE_API_KEY."));
    process.exitCode = 1;
    return;
  }
  const terms = termArg ? [termArg] : store.all().filter((c) => !c.definition_en).map((c) => c.term);
  if (terms.length === 0) {
    console.log(pc.gray(termArg ? `“${termArg}” is not in your vocabulary — add it first.` : "every card already has a meaning 🎉"));
    if (termArg) process.exitCode = 1;
    return;
  }
  if (!(await ensurePrivacyConfirmed(config, ctx.paths, {}))) {
    process.exitCode = 1;
    return;
  }

  const llm = new LlmClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
  });
  let ok = 0;
  for (const term of terms) {
    process.stdout.write(`  ${term} … `);
    const def = await defineTerm(llm, term);
    if (def) {
      store.add({
        term,
        phonetic: def.phonetic,
        definition_en: def.definition_en,
        definition_vi: def.definition_vi,
        synonyms: def.synonyms,
        tags: def.tags,
        source: def.example ? { file: "dictionary", quote: def.example } : undefined,
      });
      ok++;
      console.log(pc.green(`✓ ${def.definition_en.slice(0, 60)}`));
    } else {
      console.log(pc.red("✗ the endpoint returned no valid definition"));
    }
  }
  store.save();
  console.log(pc.bold(`\n${ok}/${terms.length} card(s) defined`));
  if (ok < terms.length) process.exitCode = 1;
}
