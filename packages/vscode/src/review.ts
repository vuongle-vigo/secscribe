/** Review orchestration: run the core pipeline on the active editor. */
import * as vscode from "vscode";
import { basename, dirname, relative } from "node:path";
import {
  LlmClient,
  ReviewCache,
  appendHistory,
  ensureStateDir,
  isEndpointConfirmed,
  markEndpointConfirmed,
  reviewDocument,
  type ReviewResult,
  type WorkspacePaths,
} from "@secscribe/core";
import { workspaceSettingsPath } from "./config.js";

export interface ReviewRun {
  result: ReviewResult;
  paths: WorkspacePaths;
  displayFile: string;
  editor: vscode.TextEditor;
}

/** §11: one-time confirmation before the first review against an endpoint. */
export async function ensurePrivacyConfirmed(baseUrl: string): Promise<boolean> {
  if (process.env["SECSRIBE_YES"] === "1") return true;
  const settingsPath = workspaceSettingsPath();
  if (settingsPath && isEndpointConfirmed(settingsPath, baseUrl)) return true;
  const pick = await vscode.window.showInformationMessage(
    `Your markdown will be sent to ${baseUrl}. Continue?`,
    { modal: true },
    "Yes, continue",
  );
  if (pick !== "Yes, continue") return false;
  if (settingsPath) markEndpointConfirmed(settingsPath, baseUrl);
  return true;
}

export async function reviewActiveEditor(
  config: Parameters<typeof reviewDocument>[0]["config"],
): Promise<ReviewRun | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("SecScribe: open a Markdown file first.");
    return null;
  }
  const doc = editor.document;
  const isMarkdown = doc.languageId === "markdown" || doc.fileName.toLowerCase().endsWith(".md");
  if (!isMarkdown) {
    void vscode.window.showWarningMessage(`SecScribe: "${basename(doc.fileName)}" is not a Markdown file.`);
    return null;
  }

  if (!(await ensurePrivacyConfirmed(config.baseUrl ?? ""))) return null;

  // The workspace folder is the root; fall back to the file's directory.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const root = folder ?? dirname(doc.fileName);
  const paths = ensureStateDir(root);
  const displayFile = folder ? relative(folder, doc.fileName) || basename(doc.fileName) : basename(doc.fileName);

  const cache = new ReviewCache(paths.cache);
  const text = doc.getText();

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "SecScribe: reviewing…" },
    () =>
      reviewDocument({
        text,
        file: displayFile,
        config,
        cache,
        llm: () =>
          new LlmClient({
            baseUrl: config.baseUrl ?? "",
            apiKey: config.apiKey ?? "",
            model: config.model ?? "",
            temperature: config.temperature,
            disableThinking: config.disableThinking,
          }),
      }),
  );

  for (const failure of result.stats.llmFailures) {
    void vscode.window.showWarningMessage(`SecScribe: ${failure}`);
  }

  // Every displayed suggestion is recorded as "seen" (§10).
  const seenAt = new Date().toISOString();
  appendHistory(
    paths.history,
    result.suggestions.map((s) => ({
      ts: seenAt,
      file: displayFile,
      sentenceHash: s.sentenceHash,
      suggestionId: s.id,
      action: "seen" as const,
    })),
  );

  return { result, paths, displayFile, editor };
}
