/** SecScribe webview — plain TS, no framework. Three tabs per SPEC §9. */

// ---- payload types (mirror the extension side) -----------------------------

interface DiffOp {
  type: "same" | "del" | "ins";
  text: string;
}

interface PanelSuggestion {
  id: string;
  category: string;
  severity: "error" | "minor";
  line: number;
  matchStatus: "applicable" | "ambiguous" | "stale";
  matchLines: number[];
  original: string;
  replacement: string;
  diff: DiffOp[];
  reasonEn: string;
  reasonVi: string;
  alternatives: string[];
  sentence: string;
}

interface PanelPayload {
  type: "review";
  file: string;
  title: string | null;
  applyMode: "self" | "assist";
  practiceMode: boolean;
  suggestions: PanelSuggestion[];
  stats: { sentences: number; cacheHits: number; batchesSent: number; rejected: number };
  dismissedCount: number;
  appliedCount: number;
}

interface VocabCard {
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
}

interface PendingVocab {
  key: string;
  term: string;
  phonetic: string;
  definitionEn: string;
  definitionVi: string;
  example: string;
  synonyms: string[];
  tags: string[];
}

interface VocabularyPayload {
  type: "vocabulary";
  cards: VocabCard[];
  pending: PendingVocab[];
}

interface StudyCard {
  term: string;
  front: string;
  termLine: string;
  definitionEn: string;
  definitionVi: string;
  quote: string | null;
  synonyms: string[];
  source: string | null;
}

interface StudyPayload {
  type: "study";
  state: "idle" | "question" | "revealed" | "summary";
  index: number;
  total: number;
  card: StudyCard | null;
  counts: { again: number; hard: number; good: number; easy: number };
  remainingDue: number;
}

interface PracticeResult {
  type: "practiceResult";
  id: string;
  verdict: "correct" | "partial" | "incorrect";
  similarity: number;
}

interface ApplyResult {
  type: "applyResult";
  id: string;
  ok: boolean;
  message: string;
}

type Rating = "again" | "hard" | "good" | "easy";

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app")!;

// ---- webview state -----------------------------------------------------------

type Tab = "suggestions" | "vocabulary" | "study";
type Surface = "panel" | "sidebar";
/** "panel": all three tabs (beside-editor review surface). "sidebar": the
 * activity-bar view — Vocabulary + Study only, Suggestions stay in the panel. */
let surface: Surface = "panel";
let activeTab: Tab = "suggestions";
let review: PanelPayload | null = null;
let vocabulary: VocabularyPayload | null = null;
let studyP: StudyPayload | null = null;
let vocabQuery = "";
/** Practice state survives re-renders so typing is not lost. */
let practice: { id: string; text: string; result?: PracticeResult } | null = null;
let toast: { message: string; kind: "info" | "error" } | null = null;

// ---- helpers -----------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderDiff(ops: DiffOp[]): string {
  return ops
    .map((op) => {
      const text = esc(op.text);
      if (op.type === "del") return `<del>${text}</del>`;
      if (op.type === "ins") return `<ins>${text}</ins>`;
      return `<span class="same">${text}</span>`;
    })
    .join("");
}

function post(msg: unknown): void {
  vscode.postMessage(msg);
}

// ---- tabs shell ---------------------------------------------------------------

function renderShell(content: string): void {
  const tabs: Array<{ id: Tab; label: string; badge?: string }> = [
    surface === "panel"
      ? { id: "suggestions", label: "Suggestions", badge: review ? String(review.suggestions.length) : undefined }
      : null,
    { id: "vocabulary", label: "Vocabulary", badge: vocabulary ? String(vocabulary.cards.length) : undefined },
    {
      id: "study",
      label: "Study",
      badge:
        studyP && studyP.state !== "summary" && studyP.total > 0
          ? `${studyP.index + 1}/${studyP.total}`
          : studyP?.remainingDue
            ? `${studyP.remainingDue} due`
            : undefined,
    },
  ].filter((t): t is { id: Tab; label: string; badge?: string } => t !== null);
  const toastHtml = toast
    ? `<div class="toast ${toast.kind === "error" ? "toast-error" : ""}">${esc(toast.message)}</div>`
    : "";
  app.innerHTML = `
<nav class="tabs">${tabs
    .map(
      (t) =>
        `<button class="tab ${activeTab === t.id ? "active" : ""}" data-tab="${t.id}">${esc(t.label)}${
          t.badge ? ` <span class="tab-badge">${esc(t.badge)}</span>` : ""
        }</button>`,
    )
    .join("")}</nav>
<div id="content">${content}</div>
${toastHtml}`;
  app.classList.remove("loading");

  app.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = (btn.dataset["tab"] as Tab) ?? "suggestions";
      post({ type: "tab", tab: activeTab });
      render();
    });
  });
}

// ---- suggestions tab -----------------------------------------------------------

function renderSuggestion(s: PanelSuggestion): string {
  const sevClass = s.severity === "error" ? "sev-error" : "sev-minor";
  const badges = [
    `<span class="badge ${sevClass}">${esc(s.severity)}</span>`,
    `<span class="badge cat">${esc(s.category)}</span>`,
    `<span class="badge line">line ${s.line}</span>`,
  ];
  if (s.matchStatus !== "applicable") badges.push(`<span class="badge warn">${s.matchStatus}</span>`);

  const alt = s.alternatives.length
    ? `<div class="alt">alternatives: ${s.alternatives.map((a) => esc(a)).join(" · ")}</div>`
    : "";

  // Sentence: hidden while an un-checked practice box is open for this item.
  const p = practice && practice.id === s.id ? practice : null;
  const hideSentence = Boolean(p && !p.result);
  const sentenceHtml = hideSentence
    ? `<div class="sentence hidden-sentence">corrected sentence hidden — type your own fix</div>`
    : `<div class="sentence">${renderDiff(s.diff)}</div>`;

  let practiceHtml = "";
  if (review?.practiceMode) {
    if (!p) {
      practiceHtml = `<button class="btn ghost practice-toggle" data-action="practiceToggle" data-id="${esc(s.id)}">Practice this fix</button>`;
    } else {
      const verdictChip = p.result
        ? `<span class="badge ${p.result.verdict === "correct" ? "sev-ok" : p.result.verdict === "partial" ? "sev-minor" : "sev-error"}">${p.result.verdict} · ${Math.round(p.result.similarity * 100)}%</span>`
        : "";
      const learnBtn =
        p.result && p.result.verdict !== "correct"
          ? `<button class="btn" data-action="practiceAddCard" data-id="${esc(s.id)}">Add to flashcards</button>`
          : "";
      practiceHtml = `<div class="practice">
        <input class="practice-input" data-action="practiceInput" data-id="${esc(s.id)}" placeholder="type your fix, then Check" value="${esc(p.text)}" ${p.result ? "disabled" : ""}>
        ${p.result ? "" : `<button class="btn" data-action="practiceCheck" data-id="${esc(s.id)}">Check</button>`}
        ${verdictChip}
        ${learnBtn}
      </div>`;
    }
  }

  let applyHtml = "";
  if (review?.applyMode === "assist" && s.matchStatus !== "stale") {
    applyHtml =
      s.matchStatus === "ambiguous"
        ? `<span class="occ-label">occurs ${s.matchLines.length}× — pick:</span> ${s.matchLines
            .map(
              (line, i) =>
                `<button class="btn ghost small" data-action="applyOcc" data-id="${esc(s.id)}" data-occ="${i}">line ${line}</button>`,
            )
            .join(" ")}`
        : `<button class="btn primary" data-action="apply" data-id="${esc(s.id)}">Apply fix</button>`;
  }

  return `<article class="item" data-id="${esc(s.id)}" data-line="${s.line}" tabindex="0">
  <header class="item-head">${badges.join(" ")}</header>
  ${sentenceHtml}
  <div class="reason"><span class="lang">EN</span> ${esc(s.reasonEn)}</div>
  <div class="reason"><span class="lang">VI</span> ${esc(s.reasonVi)}</div>
  ${alt}
  ${practiceHtml}
  <footer class="actions">
    <button class="btn" data-action="copy" data-id="${esc(s.id)}">Copy corrected text</button>
    <button class="btn" data-action="goto" data-id="${esc(s.id)}" data-line="${s.line}">Go to line</button>
    <button class="btn ghost" data-action="dismiss" data-id="${esc(s.id)}">Dismiss</button>
    ${applyHtml}
  </footer>
</article>`;
}

function renderSuggestions(): string {
  if (!review) return `<div class="empty">Run “SecScribe: Review current file” to see suggestions.</div>`;
  const parts: string[] = [];
  parts.push(`<header class="head">
  <h1>SecScribe <span class="file">${esc(review.file)}</span></h1>
  <p class="meta">${review.suggestions.length} suggestion(s) · ${review.stats.sentences} sentences · ${review.stats.cacheHits} cached${
    review.appliedCount ? ` · ${review.appliedCount} applied` : ""
  }${review.dismissedCount ? ` · ${review.dismissedCount} dismissed` : ""}${
    review.applyMode === "self" ? ' · <strong class="readonly">read-only — you fix your own text</strong>' : ""
  }</p>
</header>`);
  if (review.suggestions.length === 0) {
    parts.push(`<div class="empty">No pending suggestions. 🎉</div>`);
  } else {
    parts.push(`<div class="list">${review.suggestions.map(renderSuggestion).join("")}</div>`);
  }
  return parts.join("");
}

// ---- vocabulary tab --------------------------------------------------------------

function renderVocabulary(): string {
  const v = vocabulary;
  if (!v) return `<div class="empty">Vocabulary loads with the first review.</div>`;
  const pendingHtml = v.pending.length
    ? `<section class="pending">
      <h2>New from this review (${v.pending.length})</h2>
      ${v.pending
        .map(
          (p) => `<div class="pending-card">
        <div class="term">${esc(p.term)}${p.phonetic ? ` <span class="phonetic">${esc(p.phonetic)}</span>` : ""}</div>
        ${p.definitionEn ? `<div class="def">${esc(p.definitionEn)}</div>` : ""}
        ${p.definitionVi ? `<div class="def def-vi">${esc(p.definitionVi)}</div>` : ""}
        ${p.example ? `<div class="quote">“${esc(p.example)}”</div>` : ""}
        <div class="actions">
          <button class="btn primary" data-action="vocabConfirm" data-key="${esc(p.key)}" data-accept="1">Add</button>
          <button class="btn ghost" data-action="vocabConfirm" data-key="${esc(p.key)}" data-accept="0">Skip</button>
        </div>
      </div>`,
        )
        .join("")}
    </section>`
    : "";

  const q = vocabQuery.toLowerCase();
  const cards = v.cards.filter(
    (c) =>
      !q ||
      c.term.toLowerCase().includes(q) ||
      c.tags.some((t) => t.toLowerCase().includes(q)),
  );
  const rows = cards
    .map((c) => {
      const defs = c.definitionEn
        ? `<div class="def muted">${esc(c.definitionEn)}</div>${c.definitionVi ? `<div class="def muted def-vi">${esc(c.definitionVi)}</div>` : ""}`
        : `<div class="def muted small-text">no meaning yet</div>`;
      const defineBtn = c.definitionEn
        ? ""
        : `<button class="btn ghost small" data-action="vocabDefine" data-term="${esc(c.term)}" title="Look up the bilingual meaning">📖 Define</button>`;
      return `<tr>
      <td class="term-cell">${esc(c.term)}${c.phonetic ? ` <span class="phonetic">${esc(c.phonetic)}</span>` : ""}${defs}</td>
      <td>${c.due ? `<span class="badge sev-minor">due</span>` : `<span class="muted">${esc(c.dueDate)}</span>`}</td>
      <td class="muted">${c.repetitions} · ${c.intervalDays}d</td>
      <td class="muted">${c.tags.map((t) => esc(t)).join(", ")}</td>
      <td>${defineBtn}<button class="btn ghost small" data-action="vocabDelete" data-term="${esc(c.term)}">✕</button></td>
    </tr>`;
    })
    .join("");
  return `
<header class="head"><h1>Vocabulary</h1></header>
${pendingHtml}
<div class="vocab-toolbar">
  <input class="search" data-action="vocabSearch" placeholder="search term or tag…" value="${esc(vocabQuery)}">
  <span class="muted">${cards.length}/${v.cards.length} card(s)</span>
</div>
${cards.length ? `<table class="vocab-table">
  <thead><tr><th>Term</th><th>Due</th><th>rep · interval</th><th>Tags</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>` : `<div class="empty">No cards yet — review a post or use “SecScribe: Add selection to vocabulary”.</div>`}`;
}

// ---- study tab ---------------------------------------------------------------------

function renderStudy(): string {
  const s = studyP;
  if (!s) {
    return `<div class="empty">Study loads with the first review — or press “Start”.</div>`;
  }
  if (s.state === "idle") {
    return `<header class="head"><h1>Study</h1></header>
<div class="study-idle">
  <p class="muted">${s.remainingDue} card(s) due</p>
  <button class="btn primary big" data-action="studyStart" ${s.remainingDue === 0 ? "disabled" : ""}>Start session (${s.remainingDue} due)</button>
  <p class="hint">Space = reveal · 1–4 = Again / Hard / Good / Easy</p>
</div>`;
  }
  if (s.state === "summary") {
    const total = s.counts.again + s.counts.hard + s.counts.good + s.counts.easy;
    return `<header class="head"><h1>Session summary</h1></header>
<div class="study-summary">
  <p>Reviewed <strong>${total}</strong> card(s)</p>
  <p>again ${s.counts.again} · hard ${s.counts.hard} · good ${s.counts.good} · easy ${s.counts.easy}</p>
  <p class="muted">${s.remainingDue} still due</p>
  <button class="btn primary" data-action="studyStart" ${s.remainingDue === 0 ? "disabled" : ""}>Study again (${s.remainingDue} due)</button>
</div>`;
  }
  const card = s.card!;
  const pct = Math.round((s.index / s.total) * 100);
  const back =
    s.state === "revealed"
      ? `<div class="study-back">
    <div class="term big">${esc(card.termLine)}</div>
    ${card.definitionEn ? `<div class="def">${esc(card.definitionEn)}</div>` : ""}
    ${card.definitionVi ? `<div class="def def-vi">${esc(card.definitionVi)}</div>` : ""}
    ${card.quote ? `<div class="quote">“${esc(card.quote)}”</div>` : ""}
    ${card.synonyms.length ? `<div class="muted">syn: ${card.synonyms.map((x) => esc(x)).join(", ")}</div>` : ""}
    ${card.source ? `<div class="muted small-text">source: ${esc(card.source)}</div>` : ""}
  </div>`
      : `<div class="study-actions"><button class="btn primary big" data-action="studyReveal">Reveal (Space)</button></div>`;
  const rating =
    s.state === "revealed"
      ? `<div class="rate-row">
    <button class="btn rate rate-again" data-action="studyRate" data-rating="again">1 Again</button>
    <button class="btn rate rate-hard" data-action="studyRate" data-rating="hard">2 Hard</button>
    <button class="btn rate rate-good" data-action="studyRate" data-rating="good">3 Good</button>
    <button class="btn rate rate-easy" data-action="studyRate" data-rating="easy">4 Easy</button>
  </div>`
      : "";
  return `<header class="head"><h1>Study <span class="muted">[${s.index + 1}/${s.total}]</span></h1></header>
<div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
<div class="study-card front">${esc(card.front)}</div>
${back}
${rating}`;
}

// ---- render dispatch ----------------------------------------------------------------

function render(): void {
  const content =
    activeTab === "suggestions" ? renderSuggestions() : activeTab === "vocabulary" ? renderVocabulary() : renderStudy();
  renderShell(content);
  wireEvents();
  if (surface === "panel") {
    // The ack describes the suggestions payload (not the visible tab) so the
    // extension/test can always observe the current suggestion count.
    post({ type: "rendered", items: review?.suggestions.length ?? 0, firstLine: review?.suggestions[0]?.line });
  } else {
    post({ type: "sidebarRendered", tab: activeTab, cards: vocabulary?.cards.length ?? 0 });
  }
  const input = app.querySelector<HTMLInputElement>(".practice-input");
  if (input) input.focus();
  const search = app.querySelector<HTMLInputElement>(".search");
  if (search) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

function wireEvents(): void {
  app.querySelectorAll<HTMLElement>(".item").forEach((el) => {
    el.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest("button") || target.closest("input")) return;
      post({ type: "goto", id: el.dataset["id"]!, line: Number(el.dataset["line"]) });
    });
  });

  app.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset["action"]!;
      const id = btn.dataset["id"];
      switch (action) {
        case "copy":
        case "goto":
        case "dismiss":
          post({ type: action, id: id!, line: Number(btn.dataset["line"]) });
          return;
        case "apply":
          post({ type: "apply", id: id! });
          return;
        case "applyOcc":
          post({ type: "apply", id: id!, occurrence: Number(btn.dataset["occ"]) });
          return;
        case "practiceToggle":
          practice = { id: id!, text: "" };
          render();
          return;
        case "practiceCheck": {
          const p = practice;
          if (p && p.id === id) post({ type: "practice", id: p.id, text: p.text });
          return;
        }
        case "practiceAddCard":
          post({ type: "practiceAddCard", id: id! });
          return;
        case "vocabConfirm":
          post({ type: "vocabConfirm", key: btn.dataset["key"]!, accept: btn.dataset["accept"] === "1" });
          return;
        case "vocabDelete":
          post({ type: "vocabDelete", term: btn.dataset["term"]! });
          return;
        case "vocabDefine":
          btn.disabled = true;
          post({ type: "vocabDefine", term: btn.dataset["term"]! });
          return;
        case "studyStart":
          post({ type: "studyStart" });
          return;
        case "studyReveal":
          post({ type: "studyReveal" });
          return;
        case "studyRate":
          post({ type: "studyRate", rating: btn.dataset["rating"] as Rating });
          return;
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>(".practice-input").forEach((input) => {
    input.addEventListener("input", () => {
      if (practice) practice.text = input.value;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (practice) post({ type: "practice", id: practice.id, text: practice.text });
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>(".search").forEach((input) => {
    input.addEventListener("input", () => {
      vocabQuery = input.value;
      const pos = input.selectionStart;
      render();
      const next = app.querySelector<HTMLInputElement>(".search");
      if (next && pos !== null) next.setSelectionRange(pos, pos);
    });
  });
}

// ---- inbound messages ------------------------------------------------------------------

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as { type: string } & Record<string, unknown>;
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "review":
      review = msg as unknown as PanelPayload;
      practice = null;
      render();
      return;
    case "vocabulary":
      vocabulary = msg as unknown as VocabularyPayload;
      render(); // refreshes tab badges too; practice input state is preserved
      return;
    case "study":
      studyP = msg as unknown as StudyPayload;
      if (activeTab === "study") render();
      return;
    case "practiceResult": {
      const result = msg as unknown as PracticeResult;
      if (practice && practice.id === result.id) {
        practice.result = result;
        render();
      }
      return;
    }
    case "applyResult": {
      const result = msg as unknown as ApplyResult;
      toast = { message: result.ok ? "fix applied" : result.message, kind: result.ok ? "info" : "error" };
      render();
      setTimeout(() => {
        toast = null;
        render();
      }, 2500);
      return;
    }
    case "toast":
      toast = { message: String(msg.message), kind: (msg.kind as "info" | "error") ?? "info" };
      render();
      setTimeout(() => {
        toast = null;
        render();
      }, 2500);
      return;
    case "setTab":
      activeTab = msg.tab as Tab;
      render();
      return;
    case "surface":
      surface = (msg.surface as Surface) ?? "panel";
      if (surface === "sidebar" && activeTab === "suggestions") activeTab = "vocabulary";
      render();
      return;
  }
});

// Space = reveal, 1–4 = rate (study tab only)
document.addEventListener("keydown", (ev) => {
  if (activeTab !== "study" || !studyP) return;
  const target = ev.target as HTMLElement;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
  if (studyP.state === "question" && (ev.code === "Space" || ev.key === "Enter")) {
    ev.preventDefault();
    post({ type: "studyReveal" });
  } else if (studyP.state === "revealed" && ["1", "2", "3", "4"].includes(ev.key)) {
    ev.preventDefault();
    const ratings: Rating[] = ["again", "hard", "good", "easy"];
    post({ type: "studyRate", rating: ratings[Number(ev.key) - 1]! });
  }
});

post({ type: "ready" });
