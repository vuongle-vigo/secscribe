/**
 * Build the extension with esbuild (VS Code loads a single CJS bundle) and
 * the webview (IIFE bundle + CSS). `--tests` additionally bundles the
 * test-electron entry points.
 */
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withTests = process.argv.includes("--tests");

await mkdir(join(root, "dist", "webview"), { recursive: true });
// The bundled core engine resolves prompts relative to the bundle's __dirname
// (packages/vscode/dist -> ../prompts), so ship the prompt next to the package.
await mkdir(join(root, "prompts"), { recursive: true });
await cp(join(root, "..", "core", "src", "prompts", "review-system.md"), join(root, "prompts", "review-system.md"));

await build({
  entryPoints: [join(root, "src", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: join(root, "dist", "extension.js"),
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});

await build({
  entryPoints: [join(root, "src", "webview", "main.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  outfile: join(root, "dist", "webview", "main.js"),
  logLevel: "info",
});

await cp(join(root, "src", "webview", "styles.css"), join(root, "dist", "webview", "styles.css"));

if (withTests) {
  await mkdir(join(root, "out", "test", "suite"), { recursive: true });
  // Node side: starts the fake server (reusing the core test helper) and
  // launches VS Code with the extension under test.
  await build({
    entryPoints: [join(root, "src", "test", "runTest.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: join(root, "out", "test", "runTest.js"),
    external: ["@vscode/test-electron"],
    logLevel: "info",
  });
  // Extension-host side: mocha runner + suite (runs inside VS Code). mocha
  // stays external so the runner and the suites share a single instance.
  await build({
    entryPoints: [join(root, "src", "test", "suite", "index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: join(root, "out", "test", "suite", "index.js"),
    external: ["vscode", "mocha"],
    logLevel: "info",
  });
  await build({
    entryPoints: [join(root, "src", "test", "suite", "review.test.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: join(root, "out", "test", "suite", "review.test.js"),
    external: ["vscode", "mocha"],
    logLevel: "info",
  });
}
