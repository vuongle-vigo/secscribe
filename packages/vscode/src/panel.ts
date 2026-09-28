/**
 * SecScribe panel (webview) — the dedicated review surface (SPEC §9).
 * Three tabs: Suggestions (read-only by default), Vocabulary, Study.
 * The panel itself never edits the document; assisted apply happens through
 * the extension's apply handler, one explicit click at a time.
 */
import * as vscode from "vscode";
import type { PanelPayload } from "./serialize.js";
import type { PanelStudy } from "./study.js";
import { buildWebviewHtml } from "./webviewHtml.js";

/** webview → extension messages. */
export type PanelMessage =
  | { type: "ready" }
  | { type: "rendered"; items: number; firstLine?: number }
  | { type: "sidebarRendered"; tab: string; cards: number }
  | { type: "tab"; tab: "suggestions" | "vocabulary" | "study" }
  | { type: "copy"; id: string }
  | { type: "goto"; id: string; line: number }
  | { type: "dismiss"; id: string }
  | { type: "apply"; id: string; occurrence?: number }
  | { type: "practice"; id: string; text: string }
  | { type: "practiceAddCard"; id: string }
  | { type: "vocabAddManual"; term: string }
  | { type: "vocabDelete"; term: string }
  | { type: "vocabDefine"; term: string }
  | { type: "vocabConfirm"; key: string; accept: boolean }
  | { type: "studyStart" }
  | { type: "studyReveal" }
  | { type: "studyAnswer"; text: string }
  | { type: "studyRate"; rating: "again" | "hard" | "good" | "easy" };

/** extension → webview payloads (besides PanelPayload). */
export interface PanelVocabularyPayload {
  type: "vocabulary";
  cards: Array<{
    term: string;
    due: boolean;
    dueDate: string;
    intervalDays: number;
    repetitions: number;
    phonetic: string;
    definitionEn: string;
    definitionVi: string;
    synonyms: string[];
    tags: string[];
    sources: Array<{ file: string; quote: string }>;
  }>;
  pending: Array<{
    key: string;
    term: string;
    phonetic: string;
    definitionEn: string;
    definitionVi: string;
    example: string;
    synonyms: string[];
    tags: string[];
  }>;
}

export interface PanelPracticeResult {
  type: "practiceResult";
  id: string;
  verdict: "correct" | "partial" | "incorrect";
  similarity: number;
}

export interface PanelApplyResult {
  type: "applyResult";
  id: string;
  ok: boolean;
  message: string;
}

export interface PanelToast {
  type: "toast";
  message: string;
  kind: "info" | "error";
}

export type PanelOutbound =
  | PanelPayload
  | PanelVocabularyPayload
  | PanelPracticeResult
  | PanelApplyResult
  | PanelToast
  | PanelStudy;

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
  private revealTab: "suggestions" | "vocabulary" | "study" = "suggestions";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly handlers: {
      onMessage(msg: PanelMessage): Promise<void> | void;
    },
  ) {}

  /** Show (or reuse) the panel, optionally focusing a tab. */
  show(payload: PanelPayload, tab?: "suggestions" | "vocabulary" | "study"): void {
    this.payload = payload;
    this.rendered = null;
    if (tab) this.revealTab = tab;
    if (this.panel) {
      this.panel.reveal();
      this.post(payload);
      this.post({ type: "setTab", tab: this.revealTab });
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
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => this.handlers.onMessage(msg), undefined, this.context.subscriptions);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.webviewReady = false;
      this.rendered = null;
    });
  }

  /** Entry point for webview messages and the test hook alike. */
  async handleMessage(msg: PanelMessage): Promise<void> {
    await this.handlers.onMessage(msg);
  }

  /** Push any payload to the webview (no-op before it is ready). */
  post(payload: unknown): void {
    if (this.webviewReady) void this.panel?.webview.postMessage(payload);
  }

  /** Ask the webview to switch tabs (also queues for after readiness). */
  switchTab(tab: "suggestions" | "vocabulary" | "study"): void {
    this.revealTab = tab;
    this.post({ type: "setTab", tab });
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

  /** Webview signalled readiness: re-push the current payloads. */
  markReady(): void {
    this.webviewReady = true;
    if (this.payload) this.post(this.payload);
    this.post({ type: "setTab", tab: this.revealTab });
  }

  markRendered(items: number, firstLine?: number): void {
    this.rendered = { items, firstLine };
  }

  setDismissed(ids: string[]): void {
    this.dismissedIds = ids;
  }

  setDecoratedLines(lines: number[]): void {
    this.decoratedLines = lines;
  }

  private html(webview: vscode.Webview): string {
    return buildWebviewHtml(this.context, webview);
  }
}
