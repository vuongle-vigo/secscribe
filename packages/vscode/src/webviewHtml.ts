/** Shared webview HTML shell (nonce + CSP) for the panel and the sidebar. */
import * as vscode from "vscode";

export function buildWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "main.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "styles.css"));
  const csp = ["default-src 'none'", `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${style}">
<title>SecScribe</title>
</head>
<body>
<div id="app" class="loading">Loading SecScribe…</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
