/**
 * SecScribe panel (webview) — the dedicated, READ-ONLY review surface
 * (SPEC §9). M2 has no write path at all: per-suggestion actions are
 * Copy corrected text / Go to line / Dismiss. The panel never edits the
 * document.
 */
import * as vscode from "vscode";
import type { PanelPayload, PanelSuggestion } from "./serialize.js";

export type PanelMessage =
  | { type: "ready" }
  | { type: "rendered"; items: number; firstLine?: number }
  | { type: "copy"; id: string }
  | { type: "goto"; id: string; line: number }
  | { type: "dismiss"; id: string };

export interface PanelState {
  visible: boolean;
  payload: PanelPayload | null;
  rendered: { items: number; firstLine?: number } | null;
  dismissedIds: string[];
  decoratedLines: number[];
}

export class SecScribePanel {
  private panel: vscode.WebviewPanel | undefined;
  private payload: PanelPayload | null = null;
  private rendered: { items: number; firstLine?: number } | null = null;
  private dismissedIds: string[] = [];
  private decoratedLines: number[] = [];
  private webviewReady = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly handlers: {
      onCopy(s: PanelSuggestion): Promise<void> | void;
      onGoto(s: PanelSuggestion): Promise<void> | void;
      onDismiss(s: PanelSuggestion): Promise<void> | void;
    },
  ) {}

  /** Show (or reuse) the panel with a fresh payload. */
  show(payload: PanelPayload): void {
    this.payload = payload;
    this.rendered = null;
    if (this.panel) {
      this.panel.reveal();
      this.post();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "secscribePanel",
      "SecScribe",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        enableCommandUris: false,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
      },
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => this.handleMessage(msg), undefined, this.context.subscriptions);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.webviewReady = false;
      this.rendered = null;
    });
  }

  /** Entry point for webview messages and the test hook alike. */
  async handleMessage(msg: PanelMessage): Promise<void> {
    const find = (id: string) => this.payload?.suggestions.find((s) => s.id === id) ?? null;
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        this.post();
        return;
      case "rendered":
        this.rendered = { items: msg.items, firstLine: msg.firstLine };
        return;
      case "copy": {
        const s = find(msg.id);
        if (s) await this.handlers.onCopy(s);
        return;
      }
      case "goto": {
        const s = find(msg.id);
        if (s) await this.handlers.onGoto(s);
        return;
      }
      case "dismiss": {
        const s = find(msg.id);
        if (s) await this.handlers.onDismiss(s);
        return;
      }
    }
  }

  setDecoratedLines(lines: number[]): void {
    this.decoratedLines = lines;
  }

  setDismissed(ids: string[]): void {
    this.dismissedIds = ids;
  }

  get state(): PanelState {
    return {
      visible: Boolean(this.panel),
      payload: this.payload,
      rendered: this.rendered,
      dismissedIds: [...this.dismissedIds],
      decoratedLines: [...this.decoratedLines],
    };
  }

  private post(): void {
    if (this.payload && this.webviewReady) {
      void this.panel?.webview.postMessage(this.payload);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "styles.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
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
}
