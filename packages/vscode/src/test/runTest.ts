/**
 * Test launcher (node side): starts the fake OpenAI-compatible server from
 * packages/core/test/helpers, prepares a fixture workspace, and runs the
 * extension-host suite via @vscode/test-electron.
 */
import { runTests } from "@vscode/test-electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Cross-package import of the core fake-server test helper; esbuild inlines
// it at bundle time.
import {
  startFakeServer,
  echoResponder,
  withDefine,
  completion,
  parseCompletion,
  type Responder,
} from "../../../core/test/helpers/fake-server";

const PKG_ROOT = join(__dirname, "..", "..");

const FIXTURE_POST = [
  "# Phishing Notes",
  "",
  "The attacker use a payload. Two filters was bypassed.",
  "",
  "```bash",
  "curl https://internal.example/api",
  "```",
  "",
  "We performed reconnaissance on the subnet.",
  "",
  "The final paragraph wraps",
  "across two soft lines. Tail sentence.",
].join("\n");

/** Extra suggestion whose quote sits on the SECOND line of a wrapped sentence. */
function wrapResponder(base: Responder): Responder {
  return (req, i) => {
    const body = base(req, i);
    const user = [...req.body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (!user.includes("The final paragraph wraps across two soft lines.")) return body;
    const parsed = parseCompletion(body);
    if (!parsed) return body;
    parsed.suggestions.push({
      id: "wrap1",
      category: "word-choice",
      severity: "minor",
      original_quote: "across two soft lines",
      replacement: "over two soft lines",
      reason_en: "Fragment on the second line of a soft-wrapped sentence.",
      reason_vi: "Đoạn văn nằm ở dòng thứ hai của câu xuống dòng.",
      alternatives: [],
    });
    return completion(JSON.stringify(parsed));
  };
}

async function main(): Promise<void> {
  const server = await startFakeServer(withDefine(wrapResponder(echoResponder())));
  let exitCode = 0;
  try {
    const ws = join(tmpdir(), `secscribe-vscode-test-${Date.now()}`);
    mkdirSync(join(ws, ".secscribe"), { recursive: true });
    writeFileSync(join(ws, ".secscribe", "settings.json"), "{}\n");
    mkdirSync(join(ws, ".vscode"), { recursive: true });
    writeFileSync(
      join(ws, ".vscode", "settings.json"),
      JSON.stringify({ "secScribe.baseUrl": server.url, "secScribe.model": "test-model" }, null, 2),
    );
    writeFileSync(join(ws, "post.md"), FIXTURE_POST);

    exitCode = await runTests({
      extensionDevelopmentPath: PKG_ROOT,
      extensionTestsPath: join(PKG_ROOT, "out", "test", "suite", "index.js"),
      launchArgs: [ws, "--disable-gpu"],
      extensionTestsEnv: {
        SECSRIBE_API_KEY: "test-key-vscode",
        SECSRIBE_YES: "1",
        NO_COLOR: "1",
        SECSRIBE_TEST_WS: ws,
        SECSRIBE_TEST_EXT: PKG_ROOT,
      },
    });
  } catch (err) {
    console.error((err as Error).message);
    exitCode = 1;
  } finally {
    await server.close();
  }
  process.exit(exitCode);
}

void main();
