/**
 * SecScribe extension entry point (M3, SPEC §9/§13).
 *
 * Core UX rule: the extension NEVER modifies the user's document on its own.
 * With applyMode "self" (default) there is no write path; with "assist" the
 * only writes are single-click, per-suggestion WorkspaceEdits — never bulk,
 * never automatic, never on save.
 */
import * as vscode from "vscode";
import { writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import {
  LlmClient,
  appendHistory,
  applyEdits,
  defineTerm,
  ensureStateDir,
  gradeFix,
  toAnkiCsv,
  type WorkspacePaths,
} from "@secscribe/core";
import { ConfigService } from "./config.js";
import { DecorationManager } from "./decorations.js";
import { SecScribePanel, type PanelMessage, type PanelState } from "./panel.js";
import { ensurePrivacyConfirmed, reviewActiveEditor, type ReviewRun } from "./review.js";
import { toPanelPayload, type PanelPayload, type PanelSuggestion } from "./serialize.js";
import { StudyController } from "./study.js";
import { VocabularyService } from "./vocab.js";
import { applySuggestion } from "./apply.js";
import { SecScribeSidebar } from "./sidebar.js";

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
  // Diagnostic: resolve once at activation so config problems show in the
  // extension host log without waiting for a command run.
  void configService.resolve({ promptForKey: false }).catch((err) =>
    console.error("[secscribe] activation-time resolve failed:", err),
  );
  const decorations = new DecorationManager(context);
  const dismissed = new Set<string>();
  const applied = new Set<string>();
  let lastRun: ReviewRun | null = null;
  let vocabService: VocabularyService | null = null;
  let lastReviewPayload: PanelPayload | null = null;

  const settings = () => vscode.workspace.getConfiguration("secScribe");

  function workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) return folder;
    const editor = vscode.window.activeTextEditor;
    return editor ? dirname(editor.document.fileName) : process.cwd();
  }

  function getVocab(): VocabularyService {
    if (!vocabService) vocabService = new VocabularyService(ensureStateDir(workspaceRoot()) as WorkspacePaths);
    return vocabService;
  }

  const study = new StudyController(
    {
      raw: () => getVocab().raw(),
      dueCount: () => getVocab().dueCount(),
    },
    () => ({
      newPerDay: settings().get<number>("newCardsPerDay", 10),
      reviewsPerDay: settings().get<number>("reviewsPerDay", 50),
    }),
  );

  // ---- status bar: "$(book) SecScribe: N due" — click opens Study (§9) ----

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "secscribe.studyNow";
  statusBar.tooltip = "SecScribe — click to study due cards";
  context.subscriptions.push(statusBar);

  function refreshStatusBar(): void {
    if (!settings().get<boolean>("showStatusBar", true)) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(book) SecScribe: ${getVocab().dueCount()} due`;
    statusBar.show();
  }

  // ---- panel + sidebar --------------------------------------------------------

  const panel = new SecScribePanel(context, { onMessage: handlePanelMessage });
  const sidebar = new SecScribeSidebar(context, {
    onMessage: handlePanelMessage,
    onReady: () => {
      postVocabulary();
      pushStudy(study.payload());
    },
  });
  /** Vocabulary/study state goes to BOTH surfaces (panel + sidebar). */
  const pushBoth = (payload: unknown): void => {
    panel.post(payload);
    sidebar.post(payload);
  };
  const pushStudy = (payload: unknown): void => pushBoth(payload);

  function currentPayload(): PanelPayload {
    const run = lastRun!;
    return toPanelPayload(
      run.result,
      dismissed,
      applied,
      settings().get<"self" | "assist">("applyMode", "self"),
      settings().get<boolean>("practiceMode", false),
    );
  }

  function postVocabulary(): void {
    pushBoth({ type: "vocabulary", cards: getVocab().cards(), pending: getVocab().pendingList() });
  }

  function rerender(tab?: "suggestions" | "vocabulary" | "study"): void {
    if (!lastRun) return;
    lastReviewPayload = currentPayload();
    panel.show(lastReviewPayload, tab);
    panel.setDismissed([...dismissed]);
    refreshDecorations();
    postVocabulary();
    refreshStatusBar();
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
          .filter((s) => !dismissed.has(s.id) && !applied.has(s.id) && s.match.status !== "stale")
          // Gutter dot on the quoted text's line (first occurrence), which
          // can differ from the sentence's start line for soft-wrapped prose.
          .map((s) => s.match.lines[0] ?? s.line),
      ),
    ].sort((a, b) => a - b);
    decorations.apply(editor, lines);
    panel.setDecoratedLines(lines);
  }

  const findSuggestion = (id: string): PanelSuggestion | null =>
    lastReviewPayload?.suggestions.find((s) => s.id === id) ?? null;

  /**
   * Backfill a card's bilingual meaning via the configured endpoint (SPEC §7
   * backfill for manually added / practice-derived cards). Only the TERM is
   * sent — never document content. Fills empty fields only.
   */
  async function defineAndMerge(term: string): Promise<boolean> {
    const config = await configService.resolve({ promptForKey: false });
    if (!config) return false;
    if (!(await ensurePrivacyConfirmed(config.baseUrl ?? ""))) return false;
    const llm = new LlmClient({
      baseUrl: config.baseUrl ?? "",
      apiKey: config.apiKey ?? "",
      model: config.model ?? "",
      temperature: config.temperature,
      disableThinking: config.disableThinking,
    });
    const def = await defineTerm(llm, term);
    if (!def) return false;
    getVocab().addManual(term, def.example ? { file: "dictionary", quote: def.example } : undefined, {
      phonetic: def.phonetic,
      definition_en: def.definition_en,
      definition_vi: def.definition_vi,
      synonyms: def.synonyms,
      tags: def.tags,
    });
    postVocabulary();
    refreshStatusBar();
    return true;
  }

  type HistoryAction = "seen" | "copied" | "dismissed" | "applied" | "practiced-correct" | "practiced-partial" | "practiced-wrong";

  const record = (s: PanelSuggestion, action: HistoryAction): void => {
    if (!lastRun) return;
    appendHistory(lastRun.paths.history, [
      { ts: new Date().toISOString(), file: lastRun.displayFile, sentenceHash: s.sentenceHash, suggestionId: s.id, action },
    ]);
  };

  // ---- panel message handling --------------------------------------------------

  async function handlePanelMessage(msg: PanelMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        panel.markReady();
        return;
      case "rendered":
        panel.markRendered(msg.items, msg.firstLine);
        return;
      case "tab":
        if (msg.tab === "study") panel.post(study.payload());
        if (msg.tab === "vocabulary") postVocabulary();
        return;
      case "copy": {
        const s = findSuggestion(msg.id);
        if (s) {
          await vscode.env.clipboard.writeText(s.replacement);
          record(s, "copied");
          void vscode.window.setStatusBarMessage("SecScribe: corrected text copied", 3000);
        }
        return;
      }
      case "goto": {
        // Reveal the line and move the cursor — never change a character.
        const s = findSuggestion(msg.id);
        const editor = lastRun?.editor ?? vscode.window.activeTextEditor;
        if (!s || !editor) return;
        const pos = new vscode.Position(s.line - 1, 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
        record(s, "seen");
        return;
      }
      case "dismiss": {
        const s = findSuggestion(msg.id);
        if (s) {
          dismissed.add(s.id);
          record(s, "dismissed");
          rerender();
        }
        return;
      }
      case "apply": {
        // applyMode "assist" only: one explicit click, one exact-match edit.
        if (settings().get<"self" | "assist">("applyMode", "self") !== "assist") {
          panel.post({ type: "applyResult", id: msg.id, ok: false, message: "applyMode is 'self' — no write path" });
          return;
        }
        const s = findSuggestion(msg.id);
        const editor = lastRun?.editor;
        if (!s || !editor) return;
        const outcome = await applySuggestion(editor, s.original, s.replacement, msg.occurrence);
        if (outcome.ok) {
          applied.add(s.id);
          record(s, "applied");
          rerender();
        }
        panel.post({ type: "applyResult", id: msg.id, ok: outcome.ok, message: outcome.message });
        return;
      }
      case "practice": {
        const s = findSuggestion(msg.id);
        if (!s) return;
        const { verdict, similarity } = gradeFix(msg.text, s.replacement);
        record(s, verdict === "correct" ? "practiced-correct" : verdict === "partial" ? "practiced-partial" : "practiced-wrong");
        panel.post({ type: "practiceResult", id: msg.id, verdict, similarity });
        return;
      }
      case "practiceAddCard": {
        // Learn the corrected phrase (SPEC §7c): term = replacement, source
        // quote = the corrected sentence.
        const s = findSuggestion(msg.id);
        if (!s || !lastRun) return;
        const corrected = applyEdits(s.sentence, [{ quote: s.original, replacement: s.replacement }]);
        getVocab().addManual(s.replacement, { file: lastRun.displayFile, quote: corrected.text });
        postVocabulary();
        refreshStatusBar();
        panel.post({ type: "toast", message: `“${s.replacement.slice(0, 40)}${s.replacement.length > 40 ? "…" : ""}” added to vocabulary`, kind: "info" });
        return;
      }
      case "vocabAddManual": {
        const term = msg.term.trim();
        if (!term) return;
        const file = lastRun?.displayFile ?? "manual";
        getVocab().addManual(term, { file, quote: term });
        postVocabulary();
        refreshStatusBar();
        if (!getVocab().raw().find(term)?.definition_en) void defineAndMerge(term);
        return;
      }
      case "vocabDefine": {
        const ok = await defineAndMerge(msg.term);
        pushBoth({
          type: "toast",
          message: ok ? `meaning of “${msg.term}” added` : `could not define “${msg.term}” — check the endpoint`,
          kind: ok ? "info" : "error",
        });
        return;
      }
      case "vocabDelete": {
        if (getVocab().delete(msg.term)) {
          postVocabulary();
          refreshStatusBar();
        }
        return;
      }
      case "vocabConfirm": {
        if (lastRun) {
          getVocab().confirm(msg.key, msg.accept, lastRun.displayFile);
          postVocabulary();
          refreshStatusBar();
        }
        return;
      }
      case "studyStart":
        pushStudy(study.start());
        refreshStatusBar();
        return;
      case "studyReveal":
        pushStudy(study.reveal());
        return;
      case "studyAnswer":
        pushStudy(study.answer(msg.text));
        return;
      case "studyRate":
        pushStudy(study.rate(msg.rating));
        refreshStatusBar();
        return;
    }
  }

  // ---- commands -----------------------------------------------------------------

  const reviewFile = vscode.commands.registerCommand("secscribe.reviewFile", async () => {
    const config = await configService.resolve({ promptForKey: true });
    if (!config) return;
    const run = await reviewActiveEditor(config);
    if (!run) return;
    lastRun = run;
    vocabService = new VocabularyService(run.paths);
    dismissed.clear();
    applied.clear();

    // Vocabulary extraction (SPEC §7a): confirm each card, or auto-add.
    // No tab hijack — pending items surface on the Vocabulary tab badge.
    const ingest = vocabService.ingest(run.result.vocabulary, run.displayFile, config.vocabAutoAdd);
    if (ingest.added > 0) {
      void vscode.window.setStatusBarMessage(`SecScribe: ${ingest.added} card(s) added`, 4000);
    } else if (run.result.vocabulary.length > 0) {
      void vscode.window.setStatusBarMessage(
        `SecScribe: ${run.result.vocabulary.length} word(s) to review — see the Vocabulary tab`,
        5000,
      );
    }

    rerender();
  });

  const addSelection = vscode.commands.registerCommand("secscribe.addSelectionToVocabulary", () => {
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.selection;
    const term = selection && editor ? editor.document.getText(selection).trim() : "";
    if (!editor || !selection || !term) {
      void vscode.window.showWarningMessage("SecScribe: select a word or short phrase first.");
      return;
    }
    if (term.length > 120 || term.includes("\n")) {
      void vscode.window.showWarningMessage("SecScribe: selection is too long for a vocabulary term.");
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const file = folder
      ? relative(folder, editor.document.fileName) || basename(editor.document.fileName)
      : basename(editor.document.fileName);
    const quote = editor.document.lineAt(selection.start.line).text.trim();
    const { created } = getVocab().addManual(term, { file, quote });
    void vscode.window.setStatusBarMessage(
      created ? `SecScribe: “${term}” added` : `SecScribe: “${term}” already known — sources merged`,
      4000,
    );
    postVocabulary();
    refreshStatusBar();
    // Backfill the meaning in the background so manually added cards are
    // never definition-less (only the term itself is sent).
    if (!getVocab().raw().find(term)?.definition_en) {
      void defineAndMerge(term).then((ok) => {
        if (ok) void vscode.window.setStatusBarMessage(`SecScribe: meaning of “${term}” added`, 4000);
      });
    }
  });

  const studyNow = vscode.commands.registerCommand("secscribe.studyNow", () => {
    if (!lastRun) {
      // No review yet: synthesize an empty run so Study/Vocabulary still work.
      const folder = workspaceRoot();
      const editor = vscode.window.activeTextEditor;
      const displayFile = editor
        ? folder
          ? relative(folder, editor.document.fileName) || basename(editor.document.fileName)
          : basename(editor.document.fileName)
        : "(none)";
      lastRun = {
        result: {
          file: displayFile,
          title: null,
          suggestions: [],
          vocabulary: [],
          sentences: [],
          stats: { sentences: 0, batchesSent: 0, cacheHits: 0, llmFailures: [], rejectedSuggestions: 0 },
          usage: { promptTokens: 0, completionTokens: 0, requests: 0 },
        },
        paths: ensureStateDir(folder),
        displayFile,
        editor: (editor ?? vscode.window.activeTextEditor) as vscode.TextEditor,
      };
      lastReviewPayload = currentPayload();
    }
    // Study lives in the sidebar now — reveal it and start the session there
    // (an open panel's Study tab updates too via the shared push).
    sidebar.show();
    rerender();
    pushStudy(study.start());
  });

  const exportAnki = vscode.commands.registerCommand("secscribe.exportAnki", async (uri?: vscode.Uri) => {
    const cards = getVocab().raw().all();
    if (cards.length === 0) {
      void vscode.window.showWarningMessage("SecScribe: no cards to export yet.");
      return;
    }
    const target =
      uri ??
      (await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file("deck.csv"),
        filters: { "Anki CSV": ["csv"] },
      }));
    if (!target) return;
    writeFileSync(target.fsPath, toAnkiCsv(cards), "utf8");
    void vscode.window.showInformationMessage(`SecScribe: wrote ${target.fsPath} — ${cards.length} card(s)`);
  });

  const openSettings = vscode.commands.registerCommand("secscribe.openSettings", () => {
    void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:secscribe.secscribe");
  });

  // Test hooks (same message contract the webview uses).
  const testGetState = vscode.commands.registerCommand("secscribe.test.getState", (): PanelState & Record<string, unknown> => ({
    ...panel.state,
    appliedIds: [...applied],
    pendingVocabulary: vocabService?.pendingList() ?? [],
    vocabularyTerms: vocabService?.cards().map((c) => c.term) ?? [],
    vocabularyCards: vocabService?.cards().map((c) => ({ term: c.term, hasDefinition: Boolean(c.definitionEn) })) ?? [],
    study: study.payload(),
    statusBarText: statusBar.text,
    sidebar: sidebar.state,
  }));
  const testPostMessage = vscode.commands.registerCommand("secscribe.test.postMessage", (msg: PanelMessage) =>
    panel.handleMessage(msg),
  );

  // autoReviewOnSave (SPEC §4): review after saving a markdown file.
  // Reviews only — nothing is ever applied automatically.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!settings().get<boolean>("autoReviewOnSave", false)) return;
    if (doc.languageId !== "markdown" && !doc.fileName.toLowerCase().endsWith(".md")) return;
    if (vscode.window.activeTextEditor?.document !== doc) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void vscode.commands.executeCommand("secscribe.reviewFile"), 800);
  });

  context.subscriptions.push(
    decorations,
    statusBar,
    onSave,
    reviewFile,
    addSelection,
    studyNow,
    exportAnki,
    openSettings,
    testGetState,
    testPostMessage,
    // retainContextWhenHidden: a study session in the sidebar must survive
    // collapsing the activity-bar view.
    vscode.window.registerWebviewViewProvider("secscribe.sidebar", sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
  );
  refreshStatusBar();
}

export function deactivate(): void {
  // nothing to clean up beyond disposables
}
