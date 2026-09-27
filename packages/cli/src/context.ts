/** Shared CLI context: workspace resolution, config, §11 privacy gate. */
import pc from "picocolors";
import {
  ensureStateDir,
  findWorkspaceRoot,
  resolveConfig,
  isEndpointConfirmed,
  markEndpointConfirmed,
  workspacePaths,
  type ResolvedConfig,
  type WorkspacePaths,
} from "@secscribe/core";
import { askConfirm, askHidden } from "./ui/input.js";

export interface CliContext {
  config: ResolvedConfig;
  paths: WorkspacePaths;
}

export function buildContext(flags: Record<string, unknown>): CliContext {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const config = resolveConfig({ flags: flags as Partial<ResolvedConfig>, workspaceRoot });
  const paths = workspaceRoot ? ensureStateDir(workspaceRoot) : null;
  if (!paths) {
    // No workspace found: use the CWD as the workspace root (create state dir).
    const root = process.cwd();
    return { config, paths: ensureStateDir(root) };
  }
  return { config, paths };
}

export function displayPath(absPath: string, root: string): string {
  return absPath === root ? "." : absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : absPath;
}

/**
 * Ensure an API key is available; prompt (hidden) when missing. The key is
 * never persisted here — only kept in memory for this invocation.
 */
export async function ensureApiKey(config: ResolvedConfig): Promise<string | null> {
  if (config.apiKey) return config.apiKey;
  const key = await askHidden("API key (input hidden; export SECSRIBE_API_KEY to skip this): ");
  if (!key) {
    console.error(pc.red("No API key provided. Run `secscribe init` or set SECSRIBE_API_KEY."));
    return null;
  }
  return key;
}

/** One-time §11 confirmation before the first review against an endpoint. */
export async function ensurePrivacyConfirmed(
  config: ResolvedConfig,
  paths: WorkspacePaths,
  opts: { assumeYes?: boolean },
): Promise<boolean> {
  if (!config.baseUrl) {
    console.error(pc.red("No endpoint configured. Run `secscribe init`."));
    return false;
  }
  if (opts.assumeYes || process.env["SECSRIBE_YES"] === "1") return true;
  if (isEndpointConfirmed(paths.settings, config.baseUrl)) return true;
  const ok = await askConfirm(
    pc.yellow(`Your markdown will be sent to ${config.baseUrl}. Continue?`),
    false,
  );
  if (!ok) {
    console.error(pc.red("Aborted — nothing was sent."));
    return false;
  }
  markEndpointConfirmed(paths.settings, config.baseUrl);
  return true;
}
