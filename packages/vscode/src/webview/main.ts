/** SecScribe webview — plain TS, no framework. Renders the read-only suggestions list. */

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
  original: string;
  replacement: string;
  diff: DiffOp[];
  reasonEn: string;
  reasonVi: string;
  alternatives: string[];
}

interface PanelPayload {
  type: "review";
  file: string;
  title: string | null;
  applyMode: "self" | "assist";
  suggestions: PanelSuggestion[];
  stats: { sentences: number; cacheHits: number; batchesSent: number; rejected: number };
  dismissedCount: number;
}

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app")!;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function renderSuggestion(s: PanelSuggestion): string {
  const sevClass = s.severity === "error" ? "sev-error" : "sev-minor";
  const badges = [
    `<span class="badge ${sevClass}">${esc(s.severity)}</span>`,
    `<span class="badge cat">${esc(s.category)}</span>`,
    `<span class="badge line">line ${s.line}</span>`,
  ];
  if (s.matchStatus !== "applicable") {
    badges.push(`<span class="badge warn">${s.matchStatus}</span>`);
  }
  const alt = s.alternatives.length
    ? `<div class="alt">alternatives: ${s.alternatives.map((a) => esc(a)).join(" · ")}</div>`
    : "";
  return `<article class="item" data-id="${esc(s.id)}" data-line="${s.line}" tabindex="0">
  <header class="item-head">${badges.join(" ")}</header>
  <div class="sentence">${renderDiff(s.diff)}</div>
  <div class="reason"><span class="lang">EN</span> ${esc(s.reasonEn)}</div>
  <div class="reason"><span class="lang">VI</span> ${esc(s.reasonVi)}</div>
  ${alt}
  <footer class="actions">
    <button class="btn" data-action="copy" data-id="${esc(s.id)}">Copy corrected text</button>
    <button class="btn" data-action="goto" data-id="${esc(s.id)}" data-line="${s.line}">Go to line</button>
    <button class="btn ghost" data-action="dismiss" data-id="${esc(s.id)}">Dismiss</button>
  </footer>
</article>`;
}

function render(payload: PanelPayload): void {
  const { suggestions, stats } = payload;
  const parts: string[] = [];
  parts.push(`<header class="head">
  <h1>SecScribe <span class="file">${esc(payload.file)}</span></h1>
  <p class="meta">${suggestions.length} suggestion(s) · ${stats.sentences} sentences · ${stats.cacheHits} cached${
    payload.applyMode === "self" ? ' · <strong class="readonly">read-only — you fix your own text</strong>' : ""
  }</p>
</header>`);
  if (suggestions.length === 0) {
    parts.push(`<div class="empty">No suggestions. ${payload.dismissedCount ? `(${payload.dismissedCount} dismissed)` : ""}</div>`);
  } else {
    parts.push(`<div class="list">${suggestions.map(renderSuggestion).join("")}</div>`);
  }
  app.innerHTML = parts.join("");
  app.classList.remove("loading");

  // click-to-reveal: clicking the item (not its buttons) goes to the line
  app.querySelectorAll<HTMLElement>(".item").forEach((el) => {
    el.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest("button")) return;
      const id = el.dataset["id"]!;
      const line = Number(el.dataset["line"]);
      vscode.postMessage({ type: "goto", id, line });
    });
  });
  app.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset["action"]!;
      const id = btn.dataset["id"]!;
      if (action === "goto") {
        vscode.postMessage({ type: "goto", id, line: Number(btn.dataset["line"]) });
      } else {
        vscode.postMessage({ type: action, id });
      }
    });
  });

  vscode.postMessage({
    type: "rendered",
    items: suggestions.length,
    firstLine: suggestions[0]?.line,
  });
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as PanelPayload;
  if (msg && msg.type === "review") render(msg);
});

vscode.postMessage({ type: "ready" });
