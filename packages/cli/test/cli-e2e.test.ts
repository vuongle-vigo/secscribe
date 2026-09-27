/**
 * CLI end-to-end tests (spec §12): spawn the built CLI against a local fake
 * OpenAI-compatible server, drive interactive prompts with piped stdin, and
 * verify file writes, history, vocabulary, study, export, and status.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { echoResponder, startFakeServer, type FakeServer } from "../../core/test/helpers/fake-server.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const POST = [
  "# Phishing Notes",
  "",
  "The attacker use a payload. Two filters was bypassed.",
  "",
  "```bash",
  "curl https://internal.example/api",
  "```",
  "",
  "We performed reconnaissance on the subnet.",
].join("\n");

let fake: FakeServer;

beforeAll(async () => {
  fake = await startFakeServer(echoResponder());
});
afterAll(async () => {
  await fake.close();
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "secscribe-cli-"));
  mkdirSync(join(ws, ".secscribe"), { recursive: true });
  writeFileSync(
    join(ws, ".secscribe", "settings.json"),
    JSON.stringify({ baseUrl: fake.url, model: "test-model" }),
  );
  return ws;
}

function runCli(ws: string, args: string[], input = ""): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ws,
      env: {
        ...process.env,
        SECSRIBE_API_KEY: "test-key-e2e",
        SECSRIBE_YES: "1",
        NO_COLOR: "1",
        HOME: ws, // keep ~/... writes inside the sandbox
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function writePost(ws: string): string {
  const path = join(ws, "post.md");
  writeFileSync(path, POST);
  return path;
}

describe("CLI e2e", () => {
  it("review --json: machine output, never writes the file, strict exit code", async () => {
    const ws = makeWorkspace();
    const post = writePost(ws);
    const before = readFileSync(post, "utf8");

    const r = await runCli(ws, ["review", "post.md", "--json"]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.file).toBe("post.md");
    expect(payload.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(payload.suggestions[0]).toHaveProperty("reason_vi");
    expect(readFileSync(post, "utf8")).toBe(before); // never writes

    const strict = await runCli(ws, ["review", "post.md", "--json", "--strict"]);
    expect(strict.code).toBe(1); // error-severity suggestions exist

    // API key never appears in output or workspace files (acceptance #6)
    expect(r.stdout + r.stderr).not.toContain("test-key-e2e");
    const wsFiles = listFiles(join(ws, ".secscribe"));
    for (const f of wsFiles) expect(readFileSync(f, "utf8")).not.toContain("test-key-e2e");
  }, 30000);

  it("interactive review: y applies, n skips; writes only accepted fixes + history", async () => {
    const ws = makeWorkspace();
    const post = writePost(ws);

    // 4 suggestions (heading + 3 prose): y, y, n, n → 2 applied (the shared
    // readline must consume every piped key, not just the first); vocab cards
    // decline via EOF-default-no.
    const r = await runCli(ws, ["review", "post.md"], "y\ny\nn\nn\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("applied 2 fix");

    const after = readFileSync(post, "utf8");
    expect(after).not.toBe(POST); // file changed
    expect(after).toContain("```bash\ncurl https://internal.example/api\n```"); // code intact
    // the two accepted fixes are the first-by-line suggestions
    expect(after).toContain("# Phishing Notes!");
    expect(after).toContain("the attacker use a payload.");
    // the skipped suggestions leave their text untouched
    expect(after).toContain("Two filters was bypassed.");

    const history = readFileSync(join(ws, ".secscribe", "history.jsonl"), "utf8");
    const records = history.trim().split("\n").map((l) => JSON.parse(l));
    expect(records.filter((x) => x.action === "applied")).toHaveLength(2);
    expect(records.filter((x) => x.action === "seen")).toHaveLength(2);
  }, 30000);

  it("review --read-only: prints suggestions, never writes", async () => {
    const ws = makeWorkspace();
    const post = writePost(ws);
    const before = readFileSync(post, "utf8");
    const r = await runCli(ws, ["review", "post.md", "--read-only"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("line");
    expect(r.stdout).toContain("VI:");
    expect(readFileSync(post, "utf8")).toBe(before);
    expect(existsSync(join(ws, ".secscribe", "history.jsonl"))).toBe(false);
  }, 30000);

  it("default interactive session can leave the document untouched (q)", async () => {
    const ws = makeWorkspace();
    const post = writePost(ws);
    const before = readFileSync(post, "utf8");
    const r = await runCli(ws, ["review", "post.md"], "q\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("file untouched");
    expect(readFileSync(post, "utf8")).toBe(before);
  }, 30000);

  it("ambiguous quote: user picks the occurrence", async () => {
    const ws = makeWorkspace();
    const doc = "# T\n\nDuplicated error here. Duplicated error here.\n";
    writeFileSync(join(ws, "post.md"), doc);
    // n skips the heading fix; y accepts the ambiguous one; 1 picks the
    // first occurrence; vocab declines at EOF
    const r = await runCli(ws, ["review", "post.md"], "n\ny\n1\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("occurs 2×");
    const after = readFileSync(join(ws, "post.md"), "utf8");
    // exactly one of the two occurrences was fixed
    expect(after).toBe("# T\n\nduplicated error here. Duplicated error here.\n");
  }, 30000);

  it("cards add/list/due + export anki + status", async () => {
    const ws = makeWorkspace();

    const add = await runCli(ws, ["cards", "add", "reconnaissance"]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("added");

    const dup = await runCli(ws, ["cards", "add", "Reconnaissance"]);
    expect(dup.stdout.toLowerCase()).toContain("merged");

    const list = await runCli(ws, ["cards", "list"]);
    expect(list.stdout).toContain("reconnaissance");

    const due = await runCli(ws, ["cards", "due"]);
    expect(due.stdout).toContain("reconnaissance"); // new card is due

    const exportRes = await runCli(ws, ["export", "anki", "--out", "deck.csv"]);
    expect(exportRes.code).toBe(0);
    const csv = readFileSync(join(ws, "deck.csv"), "utf8");
    const rows = csv.trimEnd().split("\n");
    expect(rows).toHaveLength(1);
    expect((csv.match(/"/g) ?? []).length % 2).toBe(0); // balanced quotes
    expect(csv).toContain("secscribe");

    const status = await runCli(ws, ["status"]);
    expect(status.stdout).toContain("cards: 1");
    expect(status.stdout).toContain("1 due");
    expect(status.stdout).toContain("endpoint:");
  }, 30000);

  it("study: cloze → reveal → rate; SRS state persists (acceptance #4)", async () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws, ".secscribe", "vocabulary.json"),
      JSON.stringify({
        version: 1,
        cards: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            term: "reconnaissance",
            phonetic: "",
            definition_en: "Exploring a target.",
            definition_vi: "Trinh sát.",
            synonyms: ["recon"],
            tags: ["security"],
            sources: [{ file: "post.md", quote: "We performed reconnaissance on the subnet." }],
            srs: { ease: 2.5, intervalDays: 0, repetitions: 0, dueDate: "2020-01-01" },
            stats: { lapses: 0, lastReview: null },
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        daily: {},
      }),
    );

    // reveal (Enter), rate Good (3)
    const r = await runCli(ws, ["study"], "\n3\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("______"); // cloze front
    expect(r.stdout).toContain("reconnaissance"); // revealed back
    expect(r.stdout).toContain("Session summary");
    expect(r.stdout).toContain("good 1");

    const saved = JSON.parse(readFileSync(join(ws, ".secscribe", "vocabulary.json"), "utf8"));
    expect(saved.cards[0].srs.repetitions).toBe(1);
    expect(saved.cards[0].srs.intervalDays).toBe(1);
    expect(saved.cards[0].stats.lastReview).not.toBeNull();
  }, 30000);

  it("no-card workspaces behave sanely", async () => {
    const ws = makeWorkspace();
    const study = await runCli(ws, ["study"]);
    expect(study.code).toBe(0);
    expect(study.stdout.toLowerCase()).toContain("nothing due");

    const empty = await runCli(ws, ["export", "anki"]);
    expect(empty.code).toBe(1);
  }, 30000);
});

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(dir, e.name));
}
