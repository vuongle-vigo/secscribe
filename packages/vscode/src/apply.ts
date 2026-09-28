/**
 * Assisted apply (SPEC §9, applyMode "assist"): one explicit click applies a
 * single exact-match replacement via WorkspaceEdit. Never bulk, never
 * automatic, never on save — and never available in "self" mode.
 */
import * as vscode from "vscode";
import { findQuote } from "@secscribe/core";

export interface ApplyOutcome {
  ok: boolean;
  message: string;
  needsOccurrence: false;
}

export async function applySuggestion(
  editor: vscode.TextEditor,
  original: string,
  replacement: string,
  occurrence: number | undefined,
): Promise<ApplyOutcome> {
  const doc = editor.document;
  const text = doc.getText();
  const match = findQuote(text, original);
  if (match.status === "stale") {
    return { ok: false, message: "the quote is no longer in the document (stale)", needsOccurrence: false };
  }
  if (match.status === "ambiguous" && occurrence === undefined) {
    return { ok: false, message: `the quote occurs ${match.offsets.length}× — pick the occurrence first`, needsOccurrence: false };
  }
  const offset = match.offsets[Math.min(occurrence ?? 0, match.offsets.length - 1)]!;
  const start = doc.positionAt(offset);
  const end = doc.positionAt(offset + original.length);

  // Re-verify against the live document right before the edit.
  if (doc.getText(new vscode.Range(start, end)) !== original) {
    return { ok: false, message: "document changed since the review — re-run the review", needsOccurrence: false };
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(start, end), replacement);
  const applied = await vscode.workspace.applyEdit(edit);
  return applied
    ? { ok: true, message: "fix applied", needsOccurrence: false }
    : { ok: false, message: "the edit was rejected", needsOccurrence: false };
}
