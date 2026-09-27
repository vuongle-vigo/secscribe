import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Settings schema — §4 of the spec. Only non-secret keys may be persisted to
 * `.secscribe/settings.json`; `apiKey` lives in env/SecretStorage only
 * (the CLI may optionally keep it in ~/.secscribe/settings.json, which is
 * outside the workspace — see DECISIONS.md).
 */
export const SettingsSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  explanationLanguage: z.string().min(2).max(5).default("vi"),
  newCardsPerDay: z.number().int().min(0).default(10),
  reviewsPerDay: z.number().int().min(0).default(50),
  redactCodeInPrompt: z.boolean().default(true),
  autoReviewOnSave: z.boolean().default(false),
  applyMode: z.enum(["self", "assist"]).default("self"),
  practiceMode: z.boolean().default(false),
  highlightInEditor: z.boolean().default(true),
  /** Extra setting (not in §4): auto-add LLM-extracted vocabulary without confirmation. */
  vocabAutoAdd: z.boolean().default(false),
  /** Endpoints the user has confirmed for the §11 privacy prompt. */
  confirmedEndpoints: z.array(z.string()).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type PersistentSettings = Omit<Settings, "apiKey">;

const SECRET_KEYS = ["apiKey"] as const;

export function parseSettings(raw: unknown): Settings {
  return SettingsSchema.parse(sanitizeSettings(raw));
}

/**
 * Keep only known keys whose values pass their own field validation, so a
 * partially-invalid file degrades key-by-key instead of failing wholesale.
 * Values are NOT defaulted here — defaults apply once, after merging.
 */
export function sanitizeSettings(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== "object") return {};
  const shape = SettingsSchema.shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined) continue;
    const field = shape[k];
    if (field && field.safeParse(v).success) out[k] = v;
  }
  return out as Partial<Settings>;
}

export function readSettingsFile(path: string, opts: { stripSecret?: boolean } = {}): Partial<Settings> | null {
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (opts.stripSecret && raw && typeof raw === "object") {
      for (const key of SECRET_KEYS) delete (raw as Record<string, unknown>)[key];
    }
    return sanitizeSettings(raw);
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  /** Explicit CLI flags (highest priority). */
  flags?: Partial<Settings>;
  /** Workspace root — settings loaded from `<root>/.secscribe/settings.json`. */
  workspaceRoot?: string | null;
  /** Override home settings path (tests). */
  homeSettingsPath?: string;
  /** Override workspace settings path (tests). */
  workspaceSettingsPath?: string;
}

export interface ResolvedConfig extends Settings {
  /** Where the effective settings came from, for `status`/debugging. */
  sources: { baseUrl?: string; model?: string };
}

/**
 * Resolution order per spec: CLI flags > env > workspace settings >
 * ~/.secscribe/settings.json. Defaults come from the zod schema.
 */
export function resolveConfig(opts: ResolveOptions = {}): ResolvedConfig {
  const workspace: Partial<Settings> | null = opts.workspaceSettingsPath
    ? readSettingsFile(opts.workspaceSettingsPath, { stripSecret: true })
    : opts.workspaceRoot
      ? readSettingsFile(`${opts.workspaceRoot}/.secscribe/settings.json`, { stripSecret: true })
      : null;
  const home: Partial<Settings> | null = opts.homeSettingsPath
    ? readSettingsFile(opts.homeSettingsPath)
    : readSettingsFile(homeSettingsDefaultPath());

  const env: Partial<Settings> = {};
  if (process.env["SECSRIBE_API_KEY"]) env.apiKey = process.env["SECSRIBE_API_KEY"];
  if (process.env["SECSRIBE_BASE_URL"]) env.baseUrl = process.env["SECSRIBE_BASE_URL"];
  if (process.env["SECSRIBE_MODEL"]) env.model = process.env["SECSRIBE_MODEL"];

  const flags = stripUndefined(opts.flags ?? {});
  const sources: ResolvedConfig["sources"] = {};
  if (flags.baseUrl) sources.baseUrl = "flag";
  else if (env.baseUrl) sources.baseUrl = "env";
  else if (workspace?.baseUrl) sources.baseUrl = "workspace";
  else if (home?.baseUrl) sources.baseUrl = "home";
  if (flags.model) sources.model = "flag";
  else if (env.model) sources.model = "env";
  else if (workspace?.model) sources.model = "workspace";
  else if (home?.model) sources.model = "home";

  const merged = SettingsSchema.parse({
    ...home,
    ...workspace,
    ...stripUndefined(env),
    ...flags,
  });
  return { ...merged, sources };
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function homeSettingsDefaultPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return `${home}/.secscribe/settings.json`;
}

/** Serialize for persistence — secrets are never written to workspace files. */
export function toPersistentJson(settings: Settings): string {
  const copy: Record<string, unknown> = { ...settings };
  delete copy["apiKey"];
  return JSON.stringify(copy, null, 2) + "\n";
}
