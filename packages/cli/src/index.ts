#!/usr/bin/env node
/** SecScribe CLI — English writing assistant & vocabulary coach (spec §8). */
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runReview } from "./commands/review.js";
import { runCards } from "./commands/cards.js";
import { runStudy } from "./commands/study.js";
import { runExportAnki } from "./commands/exportAnki.js";
import { runStatus } from "./commands/status.js";
import { buildContext } from "./context.js";

const program = new Command();

program
  .name("secscribe")
  .description("English writing assistant and vocabulary coach for security bloggers")
  .version("0.1.0");

program
  .command("init")
  .description("configuration wizard: endpoint, key, model, test call")
  .action(async () => {
    await runInit(process.cwd());
  });

program
  .command("review")
  .description("review the English in a markdown post")
  .argument("<file>", "markdown file to review")
  .option("--read-only", "print all suggestions; never prompts, never writes")
  .option("--json", "machine-readable output; never writes (CI mode)")
  .option("--strict", "with --json: exit non-zero when error-severity suggestions exist")
  .option("--yes", "skip the one-time endpoint privacy confirmation")
  .action(async (file: string, flags) => {
    const ctx = buildContext({});
    await runReview(ctx, file, flags);
  });

program
  .command("cards")
  .description("vocabulary cards")
  .argument("<sub>", "list | add | due")
  .argument("[term]", "term (for add)")
  .action((sub: string, term?: string) => {
    const ctx = buildContext({});
    runCards(ctx, sub, term);
  });

program
  .command("study")
  .description("study due cards: cloze → reveal → rate 1–4")
  .action(async () => {
    const ctx = buildContext({});
    await runStudy(ctx);
  });

program
  .command("export")
  .description("export data")
  .argument("<format>", "anki")
  .option("--out <file>", "output file", "deck.csv")
  .action((format: string, opts: { out: string }) => {
    if (format !== "anki") {
      console.error(`unknown export format “${format}” — only anki is supported`);
      process.exitCode = 1;
      return;
    }
    const ctx = buildContext({});
    runExportAnki(ctx, opts.out);
  });

program
  .command("status")
  .description("due counts, total cards, estimated tokens in the last 7 days")
  .action(() => {
    const ctx = buildContext({});
    runStatus(ctx);
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
