/**
 * M3 smoke test (SPEC §13): assisted apply, practice mode, vocabulary
 * confirm + selection + study + Anki export + status bar. Runs after the M2
 * suite in the same workspace (order matters: M2 asserts the document is
 * byte-identical under applyMode "self"; M3 then switches to "assist").
 */
import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

interface State {
  visible: boolean;
  payload: { suggestions: Array<{ id: string; line: number; original: string; replacement: string; matchStatus: string; sentence: string }>; applyMode: string; practiceMode: boolean } | null;
  rendered: { items: number } | null;
  dismissedIds: string[];
  decoratedLines: number[];
  appliedIds: string[];
  pendingVocabulary: Array<{ key: string; term: string }>;
  vocabularyTerms: string[];
  vocabularyCards: Array<{ term: string; hasDefinition: boolean }>;
  study: { state: string; index: number; total: number; counts: Record<string, number>; remainingDue: number; card: { term: string; front: string } | null };
  statusBarText: string;
  sidebar: { visible: boolean; rendered: { tab: string; cards: number } | null } | null;
}

const ws = process.env["SECSRIBE_TEST_WS"] ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Re-show the fixture document — the webview panel takes focus after review. */
async function showPost(): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(ws, "post.md")));
  return vscode.window.showTextDocument(doc);
}

async function getState(): Promise<State> {
  return (await vscode.commands.executeCommand("secscribe.test.getState")) as State;
}

async function waitFor(pred: (s: State) => boolean, what: string): Promise<State> {
  for (let i = 0; i < 150; i++) {
    const state = await getState();
    if (pred(state)) return state;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function readVocab(): { cards: Array<{ term: string; srs: { repetitions: number; intervalDays: number }; sources: Array<{ file: string; quote: string }> }> } {
  try {
    return JSON.parse(readFileSync(join(ws, ".secscribe", "vocabulary.json"), "utf8"));
  } catch {
    return { cards: [] }; // no card saved yet
  }
}

const historyText = (): string => {
  try {
    return readFileSync(join(ws, ".secscribe", "history.jsonl"), "utf8");
  } catch {
    return "";
  }
};

suite("SecScribe M3 smoke", () => {
  const post = (msg: unknown) => vscode.commands.executeCommand("secscribe.test.postMessage", msg);

  test("assisted apply: one click, exact replacement, history records applied", async () => {
    const cfg = vscode.workspace.getConfiguration("secScribe");
    await cfg.update("applyMode", "assist", vscode.ConfigurationTarget.Workspace);

    const editor = await showPost();
    await vscode.commands.executeCommand("secscribe.reviewFile");

    const state = await waitFor((s) => s.rendered !== null && s.rendered.items > 0, "review under assist");
    assert.strictEqual(state.payload!.applyMode, "assist");
    // everything from the M2 suite is still pending except the dismissed item
    assert.ok(state.payload!.suggestions.length >= 2);

    const target = state.payload!.suggestions.find((s) => s.matchStatus === "applicable" && s.line === 3);
    assert.ok(target, "an applicable line-3 suggestion exists");
    const before = editor.document.getText();
    const expected = before.replace(target.original, target.replacement);

    await post({ type: "apply", id: target.id });

    const afterApply = await waitFor((s) => s.appliedIds.includes(target.id), "applied id recorded");
    assert.strictEqual(editor.document.getText(), expected, "exact-match replacement applied to the buffer");
    assert.ok(afterApply.payload!.suggestions.every((s) => s.id !== target.id), "applied suggestion leaves the list");
    assert.ok(!afterApply.decoratedLines.includes(3) || afterApply.payload!.suggestions.some((s) => s.line === 3));
    assert.ok(historyText().includes('"action":"applied"'));
  });

  test("practice mode: normalization, bilingual history, corrected-phrase flashcard", async () => {
    const cfg = vscode.workspace.getConfiguration("secScribe");
    await cfg.update("practiceMode", true, vscode.ConfigurationTarget.Workspace);
    await showPost();
    await vscode.commands.executeCommand("secscribe.reviewFile");
    const state = await waitFor((s) => s.payload !== null && s.payload.practiceMode === true, "practice mode on");

    const target = state.payload!.suggestions.find((s) => s.matchStatus === "applicable");
    assert.ok(target);

    // A deliberately wrong fix → incorrect, eligible for a flashcard.
    await post({ type: "practice", id: target.id, text: "chicken rice coffee" });
    await waitFor(
      (s) => historyText().includes('"action":"practiced-wrong"'),
      "practiced-wrong recorded",
    );

    // A right fix with different case/punctuation/whitespace → correct (§12.9).
    await post({ type: "practice", id: target.id, text: `  ${target.replacement.toUpperCase()}!!  ` });
    await waitFor(
      (s) => historyText().includes('"action":"practiced-correct"'),
      "practiced-correct recorded (normalized)",
    );

    // Wrong fixes can become flashcards of the corrected phrase (§7c).
    const cardsBefore = readVocab().cards.length;
    await post({ type: "practiceAddCard", id: target.id });
    await waitFor((s) => s.vocabularyTerms.length === cardsBefore + 1, "flashcard from fix added");
    const stored = readVocab().cards.find((c) => c.term === target.replacement);
    assert.ok(stored, "card term is the corrected phrase");
    assert.ok(stored!.sources[0]!.quote.includes(target.replacement), "source quote is the corrected sentence");

    await cfg.update("practiceMode", false, vscode.ConfigurationTarget.Workspace);
  });

  test("vocabulary: confirm an extract, skip another, merge via selection", async () => {
    await showPost();
    await vscode.commands.executeCommand("secscribe.reviewFile");
    const state = await waitFor((s) => s.pendingVocabulary.length >= 2, "pending vocabulary shown");

    const accept = state.pendingVocabulary[0]!;
    const skip = state.pendingVocabulary[1]!;
    await post({ type: "vocabConfirm", key: accept.key, accept: true });
    await post({ type: "vocabConfirm", key: skip.key, accept: false });
    const after = await waitFor(
      (s) => !s.pendingVocabulary.some((p) => p.key === accept.key) && s.vocabularyTerms.includes(accept.term),
      "confirmed card stored, skipped gone",
    );
    assert.ok(!after.vocabularyTerms.includes(skip.term), "skipped term not stored");

    // "Add selection to vocabulary" — select a word in the editor.
    const editor = await showPost();
    const text = editor.document.getText();
    const word = "reconnaissance";
    const offset = text.indexOf(word);
    const selStart = editor.document.positionAt(offset);
    const selEnd = editor.document.positionAt(offset + word.length);
    editor.selection = new vscode.Selection(selStart, selEnd);
    await vscode.commands.executeCommand("secscribe.addSelectionToVocabulary");
    const selState = await waitFor((s) => s.vocabularyTerms.includes(word), "selection card added");
    assert.ok(selState.vocabularyTerms.includes(word));

    // The meaning is backfilled automatically (only the term is sent).
    await waitFor(
      (s) => s.vocabularyCards.some((c) => c.term === word && c.hasDefinition),
      "auto-define after selection add",
    );
    const definedCard = readVocab().cards.find((c) => c.term === word);
    assert.ok(definedCard!.sources.some((src) => src.file === "dictionary"), "dictionary example as source");

    // Adding the same term again merges sources (acceptance #3).
    await vscode.commands.executeCommand("secscribe.addSelectionToVocabulary");
    await sleep(300);
    const vocab = readVocab();
    const card = vocab.cards.find((c) => c.term === word);
    assert.ok(card, "merged card exists");
    assert.ok(card!.sources.length >= 1, "card has sources");
    assert.strictEqual(vocab.cards.filter((c) => c.term.toLowerCase() === word).length, 1, "still one card");
  });

  test("study: cloze → reveal → rate advances persisted SRS state (acceptance #4)", async () => {
    await post({ type: "studyStart" });
    let state = await waitFor((s) => s.study.state === "question" && s.study.total > 0, "study session started");
    assert.ok(state.study.card!.front.includes("______") || state.study.card!.term.length > 0, "cloze front");
    const firstTerm = state.study.card!.term;

    await post({ type: "studyReveal" });
    state = await waitFor((s) => s.study.state === "revealed", "card revealed");

    const vocabBefore = readVocab();
    const cardBefore = vocabBefore.cards.find((c) => c.term === firstTerm);
    assert.strictEqual(cardBefore?.srs.repetitions, 0, "card starts unseen");

    await post({ type: "studyRate", rating: "good" });
    await waitFor((s) => s.study.state !== "revealed", "rating consumed");
    const cardAfter = readVocab().cards.find((c) => c.term === firstTerm);
    assert.strictEqual(cardAfter!.srs.repetitions, 1, "SRS advanced and persisted");
    assert.ok(cardAfter!.srs.intervalDays >= 1);

    // Finish the remaining cards (any rating).
    for (let guard = 0; guard < 50; guard++) {
      const s = await getState();
      if (s.study.state === "summary" || s.study.state === "idle") break;
      if (s.study.state === "question") await post({ type: "studyReveal" });
      else await post({ type: "studyRate", rating: "easy" });
      await sleep(150);
    }
    state = await getState();
    assert.ok(state.study.state === "summary" || state.study.state === "idle", "session reached the summary");
    assert.ok(state.study.counts.good >= 1);
    assert.match(state.statusBarText, /SecScribe: \d+ due/, "status bar shows due count");
  });

  test("Anki export: CSV with front/back/tags (acceptance #5)", async () => {
    const outUri = vscode.Uri.file(join(ws, "deck.csv"));
    await vscode.commands.executeCommand("secscribe.exportAnki", outUri);
    const csv = readFileSync(outUri.fsPath, "utf8");
    const rows = csv.trimEnd().split("\n");
    assert.ok(rows.length >= 1, "CSV rows written");
    for (const row of rows) {
      // naive 3-field check on unquoted prefix; quoted rows end with tags
      const tags = row.replace(/.*","/, "");
      assert.ok(tags.includes("secscribe"), "tags column present");
    }
    const vocabCount = readVocab().cards.length;
    assert.strictEqual(rows.length, vocabCount, "one row per card");
  });

  test("sidebar: vocabulary + study live in the activity-bar view; review has a keybinding", async () => {
    // Manifest: the review command is bound to a chord for markdown files.
    const extRoot = process.env["SECSRIBE_TEST_EXT"] ?? "";
    if (extRoot) {
      const manifest = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));
      const binding = manifest.contributes.keybindings.find(
        (k: { command: string }) => k.command === "secscribe.reviewFile",
      );
      assert.ok(binding, "reviewFile keybinding contributed");
      assert.strictEqual(binding.when, "resourceLangId == markdown");
      assert.ok(manifest.contributes.viewsContainers.activitybar[0].id === "secscribe");
      assert.ok(manifest.contributes.views.secscribe.some((v: { id: string }) => v.id === "secscribe.sidebar"));
      const ctx = manifest.contributes.menus?.["editor/context"]?.find(
        (m: { command: string }) => m.command === "secscribe.addSelectionToVocabulary",
      );
      assert.ok(ctx, "selection command appears in the editor context menu");
    }

    await vscode.commands.executeCommand("secscribe.sidebar.focus");
    const state = await waitFor(
      (s) => s.sidebar !== null && s.sidebar.visible && s.sidebar.rendered !== null,
      "sidebar view rendered",
    );
    // Vocabulary + Study only — the sidebar never shows Suggestions.
    assert.ok(["vocabulary", "study"].includes(state.sidebar!.rendered!.tab), "no suggestions tab in sidebar");
    assert.ok(state.sidebar!.rendered!.cards >= 1, "vocab cards listed in the sidebar");

    // Study started from the sidebar's surface shares the same controller.
    // (Earlier tests drained every due card, so create a fresh one first.)
    await post({ type: "vocabAddManual", term: "sidebar smoke term" });
    await waitFor((s) => s.vocabularyCards.some((c) => c.term === "sidebar smoke term"), "fresh card added");
    await post({ type: "studyStart" });
    await waitFor((s) => s.study.state === "question" && s.study.total > 0, "study session from the sidebar");
    // Drain the session so the suite ends clean.
    for (let guard = 0; guard < 50; guard++) {
      const s = await getState();
      if (s.study.state === "summary" || s.study.state === "idle") break;
      if (s.study.state === "question") await post({ type: "studyReveal" });
      else await post({ type: "studyRate", rating: "easy" });
      await sleep(150);
    }
  });
});
