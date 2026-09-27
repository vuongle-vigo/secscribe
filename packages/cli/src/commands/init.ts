/** `secscribe init` — configuration wizard (spec §4). */
import pc from "picocolors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ENDPOINT_SUGGESTIONS,
  LlmClient,
  SettingsSchema,
  ensureGitignore,
  parseSettings,
  readSettingsFile,
  writeWorkspaceSettings,
  type Settings,
} from "@secscribe/core";
import { askConfirm, askHidden, askLine, askNumber } from "../ui/input.js";

export async function runInit(workspaceRoot: string): Promise<void> {
  console.log(pc.bold("SecScribe init — configure your OpenAI-compatible endpoint\n"));

  const settingsPath = join(workspaceRoot, ".secscribe", "settings.json");
  const existing = readSettingsFile(settingsPath);

  // 1. Endpoint
  console.log("Pick an endpoint (any OpenAI-compatible URL works):");
  ENDPOINT_SUGGESTIONS.forEach((e, i) => console.log(`  ${i + 1}. ${e.label} — ${e.baseUrl}`));
  console.log(`  ${ENDPOINT_SUGGESTIONS.length + 1}. Custom URL…`);
  const choice = await askNumber("Endpoint", 1, ENDPOINT_SUGGESTIONS.length + 1, 1);
  let baseUrl: string;
  let modelDefault: string;
  if (choice <= ENDPOINT_SUGGESTIONS.length) {
    baseUrl = ENDPOINT_SUGGESTIONS[choice - 1]!.baseUrl;
    modelDefault = ENDPOINT_SUGGESTIONS[choice - 1]!.model;
  } else {
    baseUrl = await askLine("Base URL (e.g. https://api.example.com/v1): ");
    modelDefault = "";
  }
  while (!/^https?:\/\/.+/.test(baseUrl)) {
    baseUrl = await askLine("That does not look like a URL. Base URL: ");
  }

  // 2. API key (never written to workspace files)
  const apiKey = await askHidden("API key (input hidden): ");
  if (!apiKey) {
    console.error(pc.red("An API key is required. Aborting."));
    process.exitCode = 1;
    return;
  }

  // 3. Model
  const model = (await askLine(`Model [${modelDefault || "e.g. glm-4.6"}]: `)) || modelDefault;
  if (!model) {
    console.error(pc.red("A model name is required. Aborting."));
    process.exitCode = 1;
    return;
  }

  const temperature = existing?.temperature ?? 0.2;

  // 4. Test call
  console.log(`\nTesting ${baseUrl} with model ${model} …`);
  const llm = new LlmClient({ baseUrl, apiKey, model, temperature });
  const test = await llm.testConnection();
  if (test.ok) {
    console.log(pc.green(`✓ ${test.message}`));
  } else {
    console.error(pc.red(`✗ ${test.message}`));
    const cont = await askConfirm("Save settings anyway?", false);
    if (!cont) {
      process.exitCode = 1;
      return;
    }
  }

  // 5. Persist settings (no secrets in the workspace)
  const settings: Settings = SettingsSchema.parse({
    ...parseSettings({}),
    ...existing,
    baseUrl,
    model,
    temperature,
  });
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeWorkspaceSettings(settingsPath, settings);
  console.log(pc.green(`✓ wrote ${settingsPath}`));

  // 6. gitignore
  const gi = ensureGitignore(workspaceRoot);
  console.log(gi.added ? pc.green(`✓ added .secscribe/ to ${gi.path}`) : pc.gray(`• ${gi.path} already ignores .secscribe/`));

  // 7. Optional: remember the key outside the workspace
  const homeSettings = join(process.env["HOME"] ?? "~", ".secscribe", "settings.json");
  if (await askConfirm(`Store the API key in ${homeSettings} (outside the repo)?`, false)) {
    mkdirSync(dirname(homeSettings), { recursive: true });
    const home = existsSync(homeSettings)
      ? (() => {
          try {
            return JSON.parse(readFileSync(homeSettings, "utf8")) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : {};
    writeFileSync(homeSettings, JSON.stringify({ ...home, baseUrl, model, apiKey }, null, 2) + "\n");
    console.log(pc.green(`✓ wrote ${homeSettings}`));
  } else {
    console.log(pc.gray("Tip: export SECSRIBE_API_KEY=\"…\" so you are not prompted each run."));
  }

  console.log(`\n${pc.bold("Done.")} Try: secscribe review <file.md>`);
}
