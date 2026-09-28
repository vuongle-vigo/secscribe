/**
 * SecScribe extension entry point (M2, SPEC §9/§13).
 *
 * Core UX rule: the extension NEVER modifies the user's document on its own.
 * M2 ships no write path at all — actions are copy / go-to-line / dismiss.
 */
import * as vscode from "vscode";
import { appendHistory } from "@secscribe/core";
import { ConfigService } from "./config.js";
import { DecorationManager } from "./decorations.js";
import { SecScribePanel, type PanelMessage, type PanelState } from "./panel.js";
import { reviewActiveEditor } from "./review.js";
import { toPanelPayload, type PanelSuggestion } from "./serialize.js";

export function activate(context: vscode.ExtensionContext): void {
  console.log("[secscribe] activating extension");
  try {
    activateInner(context);
    console.log("[secscribe] extension activated");
  } catch (err) {
    console.error("[secscribe] activation failed:", err);
    throw err;
  }
}

function activateInner(context: vscode.ExtensionContext): void {
  const configService = new ConfigService(context.secrets);
  const decorations = new DecorationManager(context);
  const dismissed = new Set<string>();
  let lastRun: Awaited<ReturnType<typeof reviewActiveEditor>> = null;

  const settings = () => vscode.workspace.getConfiguration("secScribe");

  const panel = new SecScribePanel(context, {
    async onCopy(s: PanelSuggestion) {
      await vscode.env.clipboard.writeText(s.replacement);
      if (lastRun) {
        appendHistory(lastRun.paths.history, [
          { ts: new Date().toISOString(), file: lastRun.displayFile, sentenceHash: s.sentenceHash, suggestionId: s.id, action: "copied" },
        ]);
      }
      void vscode.window.setStatusBarMessage("SecScribe: corrected text copied", 3000);
    },

    async onGoto(s: PanelSuggestion) {
      // Reveal the line and move the cursor — never change a character.
      const editor = lastRun?.editor ?? vscode.window.activeTextEditor;
      if (!editor) return;
      const pos = new vscode.Position(s.line - 1, 0);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
      if (lastRun) {
        appendHistory(lastRun.paths.history, [
          { ts: new Date().toISOString(), file: lastRun.displayFile, sentenceHash: s.sentenceHash, suggestionId: s.id, action: "seen" },
        ]);
      }
    },

    async onDismiss(s: PanelSuggestion) {
      dismissed.add(s.id);
      if (lastRun) {
        appendHistory(lastRun.paths.history, [
          { ts: new Date().toISOString(), file: lastRun.displayFile, sentenceHash: s.sentenceHash, suggestionId: s.id, action: "dismissed" },
        ]);
      }
      rerender();
    },
  });

  function rerender(): void {
    if (!lastRun) return;
    const payload = toPanelPayload(lastRun.result, dismissed, settings().get<"self" | "assist">("applyMode", "self"));
    panel.show(payload);
    panel.setDismissed([...dismissed]);
    refreshDecorations();
  }

  function refreshDecorations(): void {
    if (!lastRun) return;
    const editor = lastRun.editor;
    if (!settings().get<boolean>("highlightInEditor", true)) {
      decorations.clear(editor);
      panel.setDecoratedLines([]);
      return;
    }
    const lines = [
      ...new Set(
        lastRun.result.suggestions
          .filter((s) => !dismissed.has(s.id) && s.match.status !== "stale")
          .map((s) => s.line),
      ),
    ].sort((a, b) => a - b);
    decorations.apply(editor, lines);
    panel.setDecoratedLines(lines);
  }

  const reviewFile = vscode.commands.registerCommand("secscribe.reviewFile", async () => {
    const config = await configService.resolve({ promptForKey: true });
    if (!config) return;
    const run = await reviewActiveEditor(config);
    if (!run) return;
    lastRun = run;
    dismissed.clear();
    rerender();
  });

  // Test hooks (used by the @vscode/test-electron smoke test; harmless dev
  // commands — the panel message contract is the same one the webview uses).
  const testGetState = vscode.commands.registerCommand("secscribe.test.getState", (): PanelState => panel.state);
  const testPostMessage = vscode.commands.registerCommand("secscribe.test.postMessage", (msg: PanelMessage) =>
    panel.handleMessage(msg),
  );

  context.subscriptions.push(decorations, reviewFile, testGetState, testPostMessage);
}

export function deactivate(): void {
  // nothing to clean up beyond disposables
}
