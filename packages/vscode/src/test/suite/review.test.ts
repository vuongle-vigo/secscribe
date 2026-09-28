/**
 * M2 smoke test (SPEC §12, checklist items 7 and 8): open a fixture .md,
 * run the review against the fake server, assert panel content, click an
 * item, and verify the cursor moved while the document stayed byte-identical.
 */
import * as assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

interface PanelSuggestionJson {
  id: string;
  category: string;
  severity: "error" | "minor";
  line: number;
  matchStatus: string;
  original: string;
  replacement: string;
  diff: Array<{ type: string; text: string }>;
  reasonEn: string;
  reasonVi: string;
}

interface PanelStateJson {
  visible: boolean;
  payload: { file: string; suggestions: PanelSuggestionJson[]; applyMode: string } | null;
  rendered: { items: number; firstLine?: number } | null;
  dismissedIds: string[];
  decoratedLines: number[];
}

const ws = process.env["SECSRIBE_TEST_WS"] ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForState(pred: (s: PanelStateJson) => boolean): Promise<PanelStateJson> {
  for (let i = 0; i < 300; i++) {
    const state = (await vscode.commands.executeCommand("secscribe.test.getState")) as PanelStateJson;
    if (pred(state)) return state;
    await sleep(200);
  }
  throw new Error("timed out waiting for panel state");
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

suite("SecScribe M2 smoke", () => {
  test("review → panel renders → item click moves cursor → document byte-identical", async () => {
    const postPath = join(ws, "post.md");
    const before = readFileSync(postPath);

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(postPath));
    const editor = await vscode.window.showTextDocument(doc);
    assert.strictEqual(editor.selection.active.line, 0, "cursor starts at line 1");

    // Force activation via the extension API (activation events can lag in
    // fresh test instances), then wait for the command to register.
    const all = vscode.extensions.all.map((e) => e.id);
    const ext =
      vscode.extensions.getExtension("secscribe.vscode") ??
      vscode.extensions.getExtension("secscribe.secscribe") ??
      all.filter((id) => id.includes("secscribe")).map((id) => vscode.extensions.getExtension(id)!)[0];
    assert.ok(ext, `extension not found — registered extensions: ${all.join(", ")}`);
    await ext.activate();
    for (let i = 0; i < 100; i++) {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes("secscribe.reviewFile")) break;
      await sleep(200);
      if (i === 99) throw new Error("secscribe.reviewFile never registered (extension not activated)");
    }
    await vscode.commands.executeCommand("secscribe.reviewFile");

    const state = await waitForState((s) => s.rendered !== null && s.rendered.items > 0);
    assert.strictEqual(state.visible, true, "panel should be visible");
    assert.ok(state.payload, "payload present");

    // Panel content: bilingual explanations + word-level diff + line numbers.
    const suggestions = state.payload!.suggestions;
    assert.ok(suggestions.length >= 3, `expected >= 3 suggestions, got ${suggestions.length}`);
    for (const s of suggestions) {
      assert.ok(s.reasonEn.length > 0, "reason_en present");
      assert.ok(s.reasonVi.length > 0, "reason_vi present");
      assert.ok(s.line >= 1, "line number present");
      assert.ok(s.diff.length > 0, "word diff present");
    }
    const withDiff = suggestions.find((s) => s.diff.some((op) => op.type === "del"));
    assert.ok(withDiff, "at least one suggestion has a deletion in its diff");

    // Gutter decorations cover the suggested lines (subset — stale excluded).
    assert.ok(state.decoratedLines.length > 0, "gutter dots applied");
    const payloadLines = new Set(suggestions.map((s) => s.line));
    for (const line of state.decoratedLines) assert.ok(payloadLines.has(line));

    // Checklist #8: clicking an item reveals the line and moves the cursor —
    // the text itself is never touched.
    const target = suggestions.find((s) => s.line === 3) ?? suggestions[0]!;
    await vscode.commands.executeCommand("secscribe.test.postMessage", {
      type: "goto",
      id: target.id,
      line: target.line,
    });
    // The webview panel takes focus, so read the stored editor — its cursor
    // moves even while the editor is not the active tab.
    assert.strictEqual(editor.selection.active.line, target.line - 1, "cursor moved to the suggestion line");
    assert.notStrictEqual(editor.selection.active.line, 0, "cursor actually moved away from line 1");

    // Copy action records history (clipboard content is not asserted headless).
    await vscode.commands.executeCommand("secscribe.test.postMessage", { type: "copy", id: target.id });
    const history = readFileSync(join(ws, ".secscribe", "history.jsonl"), "utf8");
    assert.ok(history.includes('"action":"copied"'), "copied action recorded");

    // Dismiss removes the item and its gutter dot.
    const beforeItems = state.rendered!.items;
    await vscode.commands.executeCommand("secscribe.test.postMessage", { type: "dismiss", id: target.id });
    const after = await waitForState(
      (s) => s.rendered !== null && s.rendered.items === beforeItems - 1 && s.dismissedIds.includes(target.id),
    );
    assert.ok(!after.decoratedLines.includes(target.line) || suggestions.some((s) => s.id !== target.id && s.line === target.line));
    assert.ok(after.payload!.suggestions.every((s) => s.id !== target.id), "dismissed item gone from payload");

    // Checklist #7: with applyMode=self a full review session leaves the
    // document byte-identical.
    const afterBytes = readFileSync(postPath);
    assert.ok(afterBytes.equals(before), "document must be byte-identical after a read-only session");

    // Acceptance #6: the API key never appears in any workspace file.
    for (const file of allFiles(ws)) {
      const content = readFileSync(file, "utf8");
      assert.ok(!content.includes("test-key-vscode"), `API key leaked into ${file}`);
    }
  });
});
