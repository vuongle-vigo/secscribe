/** `secscribe init` helpers (spec §4): gitignore, settings persistence. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./paths.js";
import type { Settings } from "./config.js";

/** Add `.secscribe/` to the workspace .gitignore (idempotent). */
export function ensureGitignore(workspaceRoot: string): { added: boolean; path: string } {
  const gitignorePath = join(workspaceRoot, ".gitignore");
  let content = "";
  if (existsSync(gitignorePath)) content = readFileSync(gitignorePath, "utf8");
  if (/^\.secscribe\/?\s*$/m.test(content)) return { added: false, path: gitignorePath };
  const newline = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, `${content}${newline}.secscribe/\n`);
  return { added: true, path: gitignorePath };
}

/** Persist non-secret settings to `.secscribe/settings.json` (never the key). */
export function writeWorkspaceSettings(settingsPath: string, settings: Settings): void {
  const { apiKey: _apiKey, ...rest } = settings;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(rest, null, 2) + "\n");
}

/** Suggested OpenAI-compatible endpoints for the init wizard. */
export const ENDPOINT_SUGGESTIONS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: "Z.ai GLM (example)", baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-4.6" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
];
