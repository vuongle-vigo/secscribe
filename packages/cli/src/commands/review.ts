/** `secscribe review <file>` — interactive / read-only / JSON review (spec §8). */
import pc from "picocolors";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  LlmClient,
  ReviewCache,
  VocabularyStore,
  appendHistory,
  applyEdits,
  reviewDocument,
  type AppliedEdit,
  type HistoryAction,
  type ReviewResult,
  type Suggestion,
} from "@secscribe/core";
import { askKey, askNumber, askConfirm, isInteractive } from "../ui/input.js";
import { renderSuggestion, renderSuggestionCompact } from "../ui/render.js";
import type { CliContext } from "../context.js";
import { displayPath, ensureApiKey, ensurePrivacyConfirmed } from "../context.js";

export interface ReviewFlags {
  readOnly?: boolean;
  json?: boolean;
  strict?: boolean;
  yes?: boolean;
}

export async function runReview(ctx: CliContext, fileArg: string, flags: ReviewFlags): Promise<void> {
  const absPath = isAbsolute(fileArg) ? fileArg : `${process.cwd()}/${fileArg}`;
  const displayFile = displayPath(absPath, ctx.paths.root);
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (err) {
    console.error(pc.red(`cannot read ${fileArg}: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  const config = { ...ctx.config };
  if (flags.json || flags.readOnly) {
    // Non-interactive modes still need credentials; fall back to env/config only.
    if (!config.apiKey || !config.baseUrl || !config.model) {
      if (flags.json) {
        console.error(pc.red("missing configuration (apiKey/baseUrl/model) — run `secscribe init`"));
        process.exitCode = 1;
        return;
      }
    }
  } else {
    const key = await ensureApiKey(config);
    if (!key) {
      process.exitCode = 1;
      return;
    }
    config.apiKey = key;
  }

  if (!(await ensurePrivacyConfirmed(config, ctx.paths, { assumeYes: flags.yes }))) {
    process.exitCode = 1;
    return;
  }

  const cache = new ReviewCache(ctx.paths.cache);
  const result = await reviewDocument({
    text,
    file: displayFile,
    config,
    cache,
    llm: () =>
      new LlmClient({
        baseUrl: config.baseUrl ?? "",
        apiKey: config.apiKey ?? "",
        model: config.model ?? "",
        temperature: config.temperature,
      }),
  });

  for (const failure of result.stats.llmFailures) console.error(pc.yellow(`! ${failure}`));

  if (flags.json) {
    printJson(result);
    if (flags.strict && result.suggestions.some((s) => s.severity === "error" && s.match.status !== "stale")) {
      process.exitCode = 1;
    }
    return;
  }

  if (flags.readOnly) {
    printReadOnly(result);
    return;
  }

  await interactive(ctx, absPath, displayFile, text, result);
}

function printJson(result: ReviewResult): void {
  const payload = {
    file: result.file,
    title: result.title,
    usage: result.usage,
    stats: result.stats,
    suggestions: result.suggestions.map((s) => ({
      id: s.id,
      category: s.category,
      severity: s.severity,
      line: s.line,
      original_quote: s.originalQuote,
      replacement: s.replacement,
      reason_en: s.reasonEn,
      reason_vi: s.reasonVi,
      alternatives: s.alternatives,
      match: s.match.status,
      occurrences: s.match.lines,
    })),
    vocabulary: result.vocabulary,
  };
  console.log(JSON.stringify(payload, null, 2));
}

function printReadOnly(result: ReviewResult): void {
  console.log(pc.bold(`\nSecScribe review — ${result.file} (read-only)\n`));
  if (result.suggestions.length === 0) {
    console.log(pc.green("No suggestions."));
  }
  result.suggestions.forEach((s, i) => {
    for (const line of renderSuggestionCompact(s, i)) console.log(line);
    console.log();
  });
  console.log(
    pc.gray(
      `${result.stats.sentences} sentences · ${result.stats.cacheHits} cached · ${result.stats.batchesSent} batches · ~${result.usage.promptTokens + result.usage.completionTokens} tokens`,
    ),
  );
}

interface Accepted {
  suggestion: Suggestion;
  occurrence: number;
}

async function interactive(
  ctx: CliContext,
  absPath: string,
  displayFile: string,
  text: string,
  result: ReviewResult,
): Promise<void> {
  const history: Array<{ suggestion: Suggestion; action: HistoryAction }> = [];
  const accepted: Accepted[] = [];
  const suggestions = result.suggestions;
  console.log(pc.bold(`\nSecScribe review — ${displayFile}`));
  console.log(pc.gray(`${suggestions.length} suggestion(s), ${result.vocabulary.length} vocabulary item(s)\n`));

  let acceptAll = false;
  let quit = false;

  for (let i = 0; i < suggestions.length && !quit; i++) {
    const s = suggestions[i]!;
    for (const line of renderSuggestion(s, i, suggestions.length)) console.log(line);

    if (s.match.status === "stale") {
      console.log(pc.yellow("  (stale — quote not found in the document; skipped)"));
      console.log();
      history.push({ suggestion: s, action: "seen" });
      continue;
    }

    let key: string | null;
    if (acceptAll) {
      key = "y";
    } else if (isInteractive()) {
      key = await askKey("  apply?", ["y", "n", "a", "q"]);
    } else {
      key = await askKey("  apply?", ["y", "n", "a", "q"], "n");
    }
    console.log();

    if (key === null || key === "q") {
      quit = true;
      history.push({ suggestion: s, action: "seen" });
      continue;
    }
    if (key === "a") acceptAll = true;
    if (key === "n") {
      history.push({ suggestion: s, action: "seen" });
      continue;
    }

    // y (or a): pick the occurrence when ambiguous.
    let occurrence = 0;
    if (s.match.status === "ambiguous") {
      console.log(pc.yellow(`  quote occurs ${s.match.offsets.length}× — pick the occurrence:`));
      s.match.lines.forEach((line, idx) => console.log(`    ${idx + 1}. line ${line}`));
      occurrence =
        (await askNumber("  occurrence", 1, s.match.offsets.length, 1)) - 1;
    }
    accepted.push({ suggestion: s, occurrence });
    history.push({ suggestion: s, action: "applied" });
  }

  // Write the file only when a fix was explicitly accepted.
  if (accepted.length > 0) {
    const edits: AppliedEdit[] = accepted.map((a) => ({
      quote: a.suggestion.originalQuote,
      replacement: a.suggestion.replacement,
      occurrence: a.occurrence,
    }));
    const applied = applyEdits(text, edits);
    writeFileSync(absPath, applied.text);
    console.log(pc.green(`✓ applied ${applied.applied.length} fix(es) to ${displayFile}`));
    for (const skip of applied.skipped) console.log(pc.yellow(`! skipped (stale): ${skip.quote.slice(0, 60)}`));
  } else {
    console.log(pc.gray("no fixes accepted — file untouched"));
  }

  appendHistory(
    ctx.paths.history,
    history.map(({ suggestion, action }) => ({
      ts: new Date().toISOString(),
      file: displayFile,
      sentenceHash: suggestion.sentenceHash,
      suggestionId: suggestion.id,
      action,
    })),
  );

  await confirmVocabulary(ctx, displayFile, result);
}

async function confirmVocabulary(ctx: CliContext, displayFile: string, result: ReviewResult): Promise<void> {
  if (result.vocabulary.length === 0) return;
  const store = new VocabularyStore(ctx.paths.vocabulary);
  console.log(pc.bold(`\nVocabulary from this post (${result.vocabulary.length})`));

  if (ctx.config.vocabAutoAdd) {
    for (const v of result.vocabulary) {
      const { card, created } = store.addFromExtract(v, displayFile);
      console.log(`  ${created ? pc.green("+") : pc.gray("•")} ${card.term}`);
    }
    store.save();
    console.log(pc.green("✓ vocabulary updated (auto-add)"));
    return;
  }

  let added = 0;
  for (const v of result.vocabulary) {
    console.log(`\n  ${pc.bold(v.term)}${v.phonetic ? pc.gray(` ${v.phonetic}`) : ""}`);
    if (v.definitionEn) console.log(`    ${v.definitionEn}`);
    if (v.definitionVi) console.log(`    ${v.definitionVi}`);
    if (v.example) console.log(pc.gray(`    “${v.example}”`));
    const ok = await askConfirm("  add to vocabulary?", false);
    if (ok) {
      store.addFromExtract(v, displayFile);
      added++;
    }
  }
  store.save();
  console.log(pc.green(`\n✓ ${added} card(s) added`));
}
