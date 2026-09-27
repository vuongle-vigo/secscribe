import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, toPersistentJson, SettingsSchema } from "../src/config.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "secscribe-cfg-"));
}

const ENV_KEYS = ["SECSRIBE_API_KEY", "SECSRIBE_BASE_URL", "SECSRIBE_MODEL"] as const;
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("config resolution (spec §4)", () => {
  it("resolution order: flags > env > workspace > home", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ baseUrl: "https://home.example/v1", model: "home-model", temperature: 1.0 }));
    mkdirSync(join(ws, ".secscribe"), { recursive: true });
    writeFileSync(join(ws, ".secscribe", "settings.json"), JSON.stringify({ baseUrl: "https://ws.example/v1", model: "ws-model" }));

    // home only
    let cfg = resolveConfig({ homeSettingsPath: join(home, "settings.json"), workspaceRoot: null });
    expect(cfg.baseUrl).toBe("https://home.example/v1");
    expect(cfg.temperature).toBe(1.0);

    // workspace overrides home
    cfg = resolveConfig({ homeSettingsPath: join(home, "settings.json"), workspaceRoot: ws });
    expect(cfg.baseUrl).toBe("https://ws.example/v1");
    expect(cfg.temperature).toBe(1.0); // home still fills unset keys

    // env overrides workspace
    process.env["SECSRIBE_BASE_URL"] = "https://env.example/v1";
    cfg = resolveConfig({ homeSettingsPath: join(home, "settings.json"), workspaceRoot: ws });
    expect(cfg.baseUrl).toBe("https://env.example/v1");

    // flags override env
    cfg = resolveConfig({
      homeSettingsPath: join(home, "settings.json"),
      workspaceRoot: ws,
      flags: { baseUrl: "https://flag.example/v1" },
    });
    expect(cfg.baseUrl).toBe("https://flag.example/v1");
  });

  it("defaults match the spec", () => {
    const cfg = resolveConfig({ workspaceRoot: null });
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.explanationLanguage).toBe("vi");
    expect(cfg.newCardsPerDay).toBe(10);
    expect(cfg.reviewsPerDay).toBe(50);
    expect(cfg.redactCodeInPrompt).toBe(true);
    expect(cfg.autoReviewOnSave).toBe(false);
    expect(cfg.applyMode).toBe("self");
    expect(cfg.practiceMode).toBe(false);
    expect(cfg.highlightInEditor).toBe(true);
  });

  it("workspace settings never supply an api key (secrets stripped on read)", () => {
    const ws = tmp();
    mkdirSync(join(ws, ".secscribe"), { recursive: true });
    writeFileSync(join(ws, ".secscribe", "settings.json"), JSON.stringify({ apiKey: "sk-leaked", baseUrl: "https://x.example/v1" }));
    const cfg = resolveConfig({ workspaceRoot: ws });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://x.example/v1");
  });

  it("corrupt settings files fall back to defaults", () => {
    const home = tmp();
    writeFileSync(join(home, "settings.json"), "{ not json");
    const cfg = resolveConfig({ homeSettingsPath: join(home, "settings.json"), workspaceRoot: null });
    expect(cfg.temperature).toBe(0.2);
  });

  it("persisted settings contain no secrets (acceptance #6)", () => {
    const settings = SettingsSchema.parse({ apiKey: "sk-secret", baseUrl: "https://x/v1", model: "m" });
    const json = toPersistentJson(settings);
    expect(json).not.toContain("sk-secret");
    expect(JSON.parse(json)).not.toHaveProperty("apiKey");
  });
});
