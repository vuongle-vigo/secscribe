/**
 * Sidebar view (activity bar): the persistent SecScribe surface for
 * Vocabulary + Study — always one click away without leaving the document.
 * Reuses the panel's webview bundle and message contract; the Suggestions
 * tab stays in the beside-editor panel only.
 */
import * as vscode from "vscode";
import { buildWebviewHtml } from "./webviewHtml.js";
import type { PanelMessage } from "./panel.js";

export interface SidebarState {
  visible: boolean;
  rendered: { tab: string; cards: number } | null;
}

export class SecScribeSidebar implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private rendered: { tab: string; cards: number } | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly handlers: {
      onMessage(msg: PanelMessage): Promise<void> | void;
      /** Fired once the webview is ready — the extension re-pushes state. */
      onReady(): void;
    },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = buildWebviewHtml(this.context, view.webview);
    view.webview.onDidReceiveMessage(
      (msg: PanelMessage) => {
        if (msg?.type === "ready") {
          this.ready = true;
          void view.webview.postMessage({ type: "surface", surface: "sidebar" });
          this.handlers.onReady();
          return;
        }
        if (msg?.type === "sidebarRendered") {
          this.rendered = { tab: msg.tab, cards: msg.cards };
          return;
        }
        void this.handlers.onMessage(msg);
      },
      undefined,
      this.context.subscriptions,
    );
    view.onDidDispose(
      () => {
        this.view = undefined;
        this.ready = false;
        this.rendered = null;
      },
      undefined,
      this.context.subscriptions,
    );
  }

  /** Reveal the sidebar (opens the activity-bar container if needed). */
  show(): void {
    void this.view?.show(true);
  }

  post(payload: unknown): void {
    if (this.ready) void this.view?.webview.postMessage(payload);
  }

  get state(): SidebarState {
    return { visible: Boolean(this.view), rendered: this.rendered };
  }
}
