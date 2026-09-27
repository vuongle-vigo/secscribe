import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore, writeWorkspaceSettings } from "../src/init.js";
import { isEndpointConfirmed, markEndpointConfirmed } from "../src/storage/privacy.js";
import { appendHistory, readHistory } from "../src/storage/history.js";
import { SettingsSchema } from "../src/config.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "secscribe-store-"));
}

describe("init helpers", () => {
  it("adds .secscribe/ to .gitignore once", () => {
    const dir = tmp();
    const first = ensureGitignore(dir);
    expect(first.added).toBe(true);
    const again = ensureGitignore(dir);
    expect(again.added).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^\.secscribe\/$/m);
    expect(readFileSync(join(dir, ".gitignore"), "utf8").split(".secscribe/").length - 1).toBe(1);
  });

  it("appends to an existing .gitignore without clobbering", () => {
    const dir = tmp();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    ensureGitignore(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(content.startsWith("node_modules/\ndist/\n")).toBe(true);
    expect(content).toMatch(/\.secscribe\/\s*$/);
  });

  it("writeWorkspaceSettings strips the api key", () => {
    const dir = tmp();
    const path = join(dir, ".secscribe", "settings.json");
    const settings = SettingsSchema.parse({ apiKey: "sk-top", baseUrl: "https://x/v1", model: "m" });
    writeWorkspaceSettings(path, settings);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("sk-top");
    expect(JSON.parse(raw).baseUrl).toBe("https://x/v1");
  });
});

describe("privacy confirmation (§11)", () => {
  it("remembers a confirmed endpoint in workspace settings", () => {
    const dir = tmp();
    const path = join(dir, ".secscribe", "settings.json");
    expect(isEndpointConfirmed(path, "https://api.example/v1")).toBe(false);
    markEndpointConfirmed(path, "https://api.example/v1");
    expect(isEndpointConfirmed(path, "https://api.example/v1")).toBe(true);
    expect(isEndpointConfirmed(path, "https://other.example/v1")).toBe(false);
    // preserves other keys
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.confirmedEndpoints).toEqual(["https://api.example/v1"]);
  });
});

describe("history (§10)", () => {
  it("appends JSONL records and reads them back", () => {
    const dir = tmp();
    const path = join(dir, "history.jsonl");
    appendHistory(path, [
      { ts: "2026-09-27T00:00:00Z", file: "a.md", sentenceHash: "h1", suggestionId: "s1", action: "seen" },
      { ts: "2026-09-27T00:00:01Z", file: "a.md", sentenceHash: "h1", suggestionId: "s1", action: "applied" },
    ]);
    appendHistory(path, [
      { ts: "2026-09-27T00:00:02Z", file: "a.md", sentenceHash: "h2", suggestionId: "s2", action: "practiced-wrong" },
    ]);
    const records = readHistory(path);
    expect(records).toHaveLength(3);
    expect(records[2]!.action).toBe("practiced-wrong");
  });

  it("skips corrupt lines when reading", () => {
    const dir = tmp();
    const path = join(dir, "history.jsonl");
    writeFileSync(path, "not json\n" + JSON.stringify({ ts: "t", file: "f", sentenceHash: "h", suggestionId: "s", action: "copied" }) + "\n");
    expect(readHistory(path)).toHaveLength(1);
  });
});
