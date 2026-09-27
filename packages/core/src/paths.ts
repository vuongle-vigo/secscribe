import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export const STATE_DIR = ".secscribe";

export interface WorkspacePaths {
  root: string;
  stateDir: string;
  settings: string;
  vocabulary: string;
  history: string;
  cache: string;
}

/**
 * Walk up from `start` looking for the workspace root: the nearest directory
 * that contains `.secscribe/`, falling back to the nearest git root. Returns
 * null when neither is found (running outside any project).
 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, STATE_DIR))) return dir;
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function workspacePaths(root: string): WorkspacePaths {
  const stateDir = join(root, STATE_DIR);
  return {
    root,
    stateDir,
    settings: join(stateDir, "settings.json"),
    vocabulary: join(stateDir, "vocabulary.json"),
    history: join(stateDir, "history.jsonl"),
    cache: join(stateDir, "cache.json"),
  };
}

export function ensureStateDir(root: string): WorkspacePaths {
  const paths = workspacePaths(root);
  mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

export function homePaths(): WorkspacePaths {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return workspacePaths(join(home, ".secscribe"));
}
