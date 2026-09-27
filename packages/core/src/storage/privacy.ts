/**
 * §11 privacy confirmation: one-time confirmation before the first review
 * against an endpoint. Confirmations are recorded per endpoint in the
 * workspace settings file.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CONFIRM_KEY = "confirmedEndpoints";

export function readWorkspaceSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isEndpointConfirmed(settingsPath: string, baseUrl: string): boolean {
  const settings = readWorkspaceSettings(settingsPath);
  const list = settings[CONFIRM_KEY];
  return Array.isArray(list) && list.includes(baseUrl);
}

export function markEndpointConfirmed(settingsPath: string, baseUrl: string): void {
  const settings = readWorkspaceSettings(settingsPath);
  const list = Array.isArray(settings[CONFIRM_KEY]) ? (settings[CONFIRM_KEY] as unknown[]) : [];
  if (!list.includes(baseUrl)) list.push(baseUrl);
  settings[CONFIRM_KEY] = list;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
