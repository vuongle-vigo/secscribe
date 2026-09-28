/**
 * Extension configuration (SPEC §4): merge VS Code settings > env >
 * workspace `.secscribe/settings.json` > `~/.secscribe/settings.json`.
 * The API key lives in VS Code SecretStorage (fallbacks: SECSRIBE_API_KEY
 * env, home settings file) and is never written to workspace files or logs.
 */
import * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SettingsSchema,
  readSettingsFile,
  type ResolvedConfig,
  type Settings,
} from "@secscribe/core";

export const SECRET_API_KEY = "secscribe.apiKey";

export function workspaceRoot(): string | null {
  // The extension never walks up from process.cwd() — the workspace folder is
  // the authoritative root (see DECISIONS.md).
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : null;
}

export function workspaceSettingsPath(): string | null {
  const root = workspaceRoot();
  return root ? join(root, ".secscribe", "settings.json") : null;
}

export function homeSettingsPath(): string {
  return join(homedir(), ".secscribe", "settings.json");
}

function pickEnv(): Partial<Settings> {
  const env: Partial<Settings> = {};
  if (process.env["SECSRIBE_API_KEY"]) env.apiKey = process.env["SECSRIBE_API_KEY"];
  if (process.env["SECSRIBE_BASE_URL"]) env.baseUrl = process.env["SECSRIBE_BASE_URL"];
  if (process.env["SECSRIBE_MODEL"]) env.model = process.env["SECSRIBE_MODEL"];
  return env;
}

function pickVsCodeSettings(): Partial<Settings> {
  const cfg = vscode.workspace.getConfiguration("secScribe");
  const out: Record<string, unknown> = {};
  const shape = SettingsSchema.shape as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    if (key === "apiKey" || key === "confirmedEndpoints") continue;
    const value = cfg.get(key);
    // An empty string (cleared field in the Settings UI) must not shadow a
    // valid value from the settings files — treat it as unset.
    if (typeof value === "string" && value.trim() === "") continue;
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<Settings>;
}

export class ConfigService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Resolve the effective config. Returns null (with a warning shown) when a
   * required piece is missing and cannot be prompted for.
   */
  async resolve(opts: { promptForKey?: boolean } = {}): Promise<ResolvedConfig | null> {
    const wsFile = workspaceSettingsPath()
      ? readSettingsFile(workspaceSettingsPath()!, { stripSecret: true })
      : null;
    const home = readSettingsFile(homeSettingsPath());
    const homeWithSecrets = readSettingsFile(homeSettingsPath());
    const env = pickEnv();
    const vsCode = pickVsCodeSettings();

    // Diagnostics only — the API key is NEVER printed (acceptance #6).
    console.log(
      "[secscribe] config layers:",
      JSON.stringify({
        home: home ? { ...home, apiKey: home.apiKey ? "***set***" : undefined } : null,
        wsFile,
        env: Object.keys(env),
        vsCode,
      }),
    );

    let merged: Settings;
    try {
      merged = SettingsSchema.parse({
        ...home,
        ...wsFile,
        ...env,
        ...vsCode,
      });
    } catch (err) {
      console.error("[secscribe] settings merge failed:", err);
      void vscode.window.showErrorMessage(
        "SecScribe: invalid configuration — check secScribe.* settings and ~/.secscribe/settings.json (see logs).",
      );
      return null;
    }

    // API key: SecretStorage > env > home file; workspace files never supply it.
    const stored = await this.secrets.get(SECRET_API_KEY);
    let apiKey: string | undefined = stored ?? env.apiKey ?? homeWithSecrets?.apiKey;

    if (!apiKey && opts.promptForKey) {
      const entered = await vscode.window.showInputBox({
        prompt: "SecScribe API key (stored in VS Code SecretStorage, never in workspace files)",
        password: true,
        ignoreFocusOut: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await this.secrets.store(SECRET_API_KEY, apiKey);
        void vscode.window.showInformationMessage("SecScribe: API key stored in SecretStorage.");
      }
    }

    if (!merged.baseUrl || !merged.model) {
      void vscode.window.showErrorMessage(
        "SecScribe: baseUrl/model are not configured. Set secScribe.baseUrl and secScribe.model (or run `secscribe init` in a terminal).",
      );
      return null;
    }
    if (!apiKey) {
      void vscode.window.showErrorMessage("SecScribe: no API key. Run the review command again to enter one.");
      return null;
    }
    return { ...merged, apiKey, sources: {} };
  }
}
