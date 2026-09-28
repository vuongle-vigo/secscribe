/** Gutter dot on lines with pending suggestions (SPEC §9: visual hint only). */
import * as vscode from "vscode";

export class DecorationManager implements vscode.Disposable {
  private readonly type: vscode.TextEditorDecorationType;

  constructor(context: vscode.ExtensionContext) {
    this.type = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, "media", "dot.svg"),
      gutterIconSize: "10px",
    });
  }

  apply(editor: vscode.TextEditor, lines: number[]): void {
    const ranges = lines.map((line) => new vscode.Range(line - 1, 0, line - 1, 0));
    editor.setDecorations(this.type, ranges);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.type, []);
  }

  dispose(): void {
    this.type.dispose();
  }
}
