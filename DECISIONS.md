# DECISIONS.md

Ambiguities resolved while building SecScribe v1 (per the spec's instruction:
pick the simpler option and record it here).

## Configuration

- **API key persistence (CLI)**: the key is never written to workspace files.
  The CLI reads `SECSRIBE_API_KEY`, prompts (hidden input), or — when the user
  opts in during `secscribe init` — reads it from `~/.secscribe/settings.json`
  (outside the repo, `chmod 600`). This follows §4 ("the key is never written
  to workspace files") while letting `secscribe init` offer a no-prompt setup.
- **Workspace settings never supply a key**: `readSettingsFile` strips
  `apiKey` when reading `<workspace>/.secscribe/settings.json`, even if
  someone hand-edits it in.
- **Env vars**: `SECSRIBE_API_KEY`, `SECSRIBE_BASE_URL`, `SECSRIBE_MODEL` sit
  between CLI flags and settings files in the resolution order.
- **`explanationLanguage`**: accepted in settings (default `"vi"`) but the v1
  system prompt is the verbatim bilingual EN+VI prompt from §6.3; other values
  are stored but do not change the prompt in v1.
- **`vocabAutoAdd` (extra setting)**: §7 says LLM-extracted cards are confirmed
  "by default, with an auto-add setting" without naming the key. The key is
  `vocabAutoAdd` (default `false`).
- **Settings files degrade key-by-key**: unknown keys are dropped and invalid
  values fall through to the next layer/default instead of failing the whole
  file (a corrupt settings file never blocks the CLI).
- **`redactCodeInPrompt: false`**: sends unmasked sentence text, but the
  safety gate is unchanged — any suggestion whose quote range touches a
  protected segment is rejected, so this flag cannot weaken §5.
- **Privacy confirmation storage**: per-endpoint confirmations live in
  `confirmedEndpoints` inside the workspace settings file; `--yes` or
  `SECSRIBE_YES=1` skips the prompt for CI.

- **`disableThinking` (extra setting)**: coding-plan endpoints serve a GLM
  reasoning model by default; a non-streaming review batch then reasons for
  minutes until the connection is reset (~10 min, connection reset by peer —
  reproduced with curl, 2026-09-28). The client sends
  `thinking: {type: "disabled"}` (GLM parameter) when the setting is `"on"`,
  or `"auto"` (default) and the endpoint host is `z.ai`/`bigmodel.cn`; other
  OpenAI-compatible servers never see the parameter. Measured: 585s reset →
  26.6s with thinking disabled.

- **Empty-string VS Code settings are unset**: a cleared field in the Settings
  UI yields `""`, which shadowed valid values from `~/.secscribe/settings.json`
  and failed zod validation instantly (`invalid_url` / `min(1)` — surfaced as
  the review command dying before any request, 2026-09-28). `resolve()` now
  skips empty strings from the VS Code layer and shows a friendly message if
  the merged settings still fail validation. It also logs the config layers to
  the extension host log and resolves once at activation for diagnostics.

## Markdown safety

- **Placeholder format**: `⟦<Letter><Number>⟧` with per-kind counters —
  F=frontmatter, C=code fence, I=inline code, U=URL, H=HTML (e.g. `⟦C1⟧`,
  `⟦I2⟧`).
- **Fence indent**: fences are recognized with up to 6 leading spaces (not
  CommonMark's 3) so fences inside list items are protected. Trade-off:
  a deeply-indented "fence-looking" line could be over-protected — safe
  direction (more protection, never less).
- **Frontmatter**: only recognized when the document starts with `---` and a
  closing `---`/`...` line exists; the whole block is one protected segment,
  so keys and order are untouched by construction.
- **Unclosed fences** are protected to EOF.
- **Inline code spans**: the closing backtick run must equal the opening run
  (CommonMark). A code span therefore cannot close on a shorter run inside
  `` `…` `` text.
- **Markdown links**: `[text](url)` — only the destination is protected; the
  link text remains prose. Bare `http(s)://…` URLs and `<autolinks>` are
  protected. Destinations containing parentheses are cut at the first `)`.
- **Raw HTML**: inline tags, comments, and `<?…?>` are protected; multi-line
  attribute tags are treated per line (rare, accepted limitation).
- **Multi-paragraph sentences**: sentences never cross blank lines. Soft line
  breaks are joined into the sentence text (words separated by a single
  space). List markers, blockquote `>`, and table rows are stripped/skipped —
  table rows are treated as layout, not prose (not reviewed in v1).
- **Suggestion attribution**: a batch reply covers up to 8 sentences; each
  suggestion is attributed to the sentence containing its quote (fallback:
  the batch's first sentence) and deduped by `(id, quote)` so a cached batch
  reply is never emitted twice.
- **Safety gate is double**: (a) quotes/replacements containing placeholder
  patterns are rejected; (b) every occurrence of the quote in the document
  must lie fully in prose — a quote appearing inside code *anywhere* rejects
  the suggestion entirely (conservative).

## Application

- **Overlapping accepted edits**: edits apply ascending with offset deltas and
  re-verify the quoted span before replacing; an edit whose span was already
  changed by an earlier accepted edit is skipped (`overwritten-by-earlier-edit`)
  rather than guessed.
- **`a` (accept-all)**: accepts the current and all remaining applicable
  suggestions; ambiguous ones still prompt for the occurrence.
- **`q` (quit)**: already-accepted fixes still apply ("writes the file only
  when a fix was explicitly accepted" — they were).

## Review pipeline

- **Batch user prompt**: numbered sentences `[1] …` under the post title,
  followed by the §6.4 JSON schema embedded verbatim in every request — the
  system prompt says "matching the provided schema", and without the schema
  in the message GLM invents its own field names (`explanation_en` instead
  of `reason_en`, etc.) and every batch dies in validation. `promptVersion`
  hashes the system prompt + schema block so schema changes invalidate the
  cache. The system prompt itself is the verbatim §6.3 text stored at
  `core/src/prompts/review-system.md` (copied to `dist/prompts/` at build
  time).
- **Suggestion attribution at store time**: each suggestion/vocab item is
  assigned to the sentence containing its quote (fallback: the batch's first
  sentence) *before* the per-sentence cache entry is written, so cache-hit
  reruns report the same line numbers as live runs.
- **JSON extraction** tolerates markdown fences and surrounding commentary
  (slice first `{` … last `}`) before zod validation. One repair-retry
  (assistant reply echoed back + correction request); a still-invalid reply
  drops the batch and is reported in `stats.llmFailures` — the run never
  throws.
- **Schema strictness**: optional vocabulary fields default to empty; missing
  required suggestion fields (e.g. `reason_vi`) fail validation and trigger
  the repair path (no silent `.catch` rescues).
- **Cache**: key = sha256(sentence + model + prompt-version); entries store
  the suggestions/vocabulary, timestamps, and token usage so unchanged
  sentences never re-send and `status` can report 7-day token estimates.
  Batch usage is attributed evenly across its sentences. A fully-cached
  review works with no network at all.
- **`promptVersion`** = sha256 of the system prompt file (8 hex chars), so a
  prompt change invalidates the cache.

## Vocabulary / SRS

- **SM-2 variant (Anki classic)**, day-granular:
  - ease modifiers: Again −0.20, Hard −0.15, Good ±0, Easy +0.15, clamped to [1.3, 3.0]
  - Again: lapse — repetitions 0, interval 0, due today
  - Hard: 1 day when new, else round(interval × 1.2)
  - Good: 1 → 6 → round(interval × ease)
  - Easy: 3 → 8 → round(interval × ease × 1.3)
- **`newCardsPerDay`** counts cards that *graduate* (first non-Again review)
  per day; `reviewsPerDay` counts all reviews. Counters persist in
  `vocabulary.json` under `daily` (not a file listed in §10 — kept inside
  `vocabulary.json` to avoid adding new storage files).
- **Duplicate merge**: case-insensitive by term; existing card fields win,
  only empty fields are filled; sources deduped by (file, quote), capped at 3,
  newest-first-in-sorted-order (sorted by file then quote).
- **Cloze**: whole-word, case-insensitive blank (`______`); if the term is
  absent from the example sentence, the card falls back to a
  "What does … mean?" prompt.
- **Manual `cards add <term>`** creates a card with empty definitions and no
  source; it is due immediately.

## Anki export

- CSV columns `front,back,tags`; fields are HTML (newlines → `<br>`); quotes
  doubled; fields wrapped when they contain comma/quote/newline; every card
  gets the `secscribe` tag plus its own tags (spaces → underscores).
- No `#separator` header line — plain comma CSV auto-detected by Anki 2.1.x.

## CLI

- **Interactive keys**: raw single keypress on a TTY (`y`/`n`/`a`/`q`, `1–4`);
  line-based when stdin is piped. Piped lines go through one permanent
  line-queue — readline emits `line` events even with no listener attached,
  so per-call interfaces silently drop every line arriving between prompts
  (only the first key registers and the rest fall back to "n"). EOF degrades
  to the safe default (skip / quit).
- **`--read-only` and `--json`** write nothing — not even `history.jsonl`
  (interactive sessions record `applied`/`seen` per §10; `copied`/`dismissed`
  are reserved for the extension, M2).
- **`export anki --out`** defaults to `deck.csv` in the CWD.
- **`status` token estimate**: reported usage from the endpoint when
  available, else ceil(chars/4) + 64 completion tokens per cached sentence,
  over the last 7 days.

## VS Code extension (M2)

- **Panel**: single Suggestions tab for M2 (the Vocabulary and Study tabs are
  M3 per §13). Read-only: actions are Copy corrected text / Go to line /
  Dismiss. There is no write path in M2 at all — `applyMode` is accepted in
  settings (and shown in the panel header) but "assist" behaves exactly like
  "self" until M3.
- **Config resolution in the extension**: VS Code settings act as the
  highest layer (the UI equivalent of CLI flags): VS Code settings > env
  (`SECSRIBE_API_KEY`/`SECSRIBE_BASE_URL`/`SECSRIBE_MODEL`) > workspace
  `.secscribe/settings.json` > `~/.secscribe/settings.json`. The API key
  resolution is SecretStorage > env > home file; workspace settings never
  supply a key (stripped on read). The key is collected via a password
  InputBox on first review and stored only in SecretStorage.
- **Workspace root** in the extension is `workspaceFolders[0]` (never a
  `process.cwd()` walk-up, which inside the extension host is not the
  user's project).
- **§11 privacy confirmation**: modal `showInformationMessage` once per
  endpoint, persisted via `confirmedEndpoints` in the workspace settings;
  `SECSRIBE_YES=1` skips it (same env contract as the CLI).
- **History mapping (§10)**: rendering a review records `seen` for every
  suggestion; Copy records `copied`; Dismiss records `dismissed`; Go to line
  records `seen` (no dedicated action exists in the §10 set).
- **Dismissed suggestions** are in-memory per review run + `dismissed`
  history records; they are not persisted across runs.
- **Gutter dot**: a single `gutterIconPath` decoration type (media/dot.svg)
  on the lines of non-dismissed, non-stale suggestions; refreshed after
  dismiss. `highlightInEditor: false` clears it.
- **Command scope for M2**: only `SecScribe: Review current file` (Add
  selection to vocabulary / Study now / Export Anki CSV are M3; §13 puts
  vocabulary, study, and export there). Two test-only commands
  (`secscribe.test.getState`, `secscribe.test.postMessage`) are contributed
  for the smoke test — they expose the same panel state and message contract
  the webview uses, nothing more.
- **Webview testing strategy**: the smoke test asserts the panel via the
  serialized payload + a `rendered` ack the webview posts after drawing
  (item count, first line), and drives clicks by posting the exact webview
  messages through the same handler. No DOM automation inside the webview —
  the message contract is the tested surface (recorded here per the spec's
  testing instructions).
- **Bundling**: esbuild — extension as CJS (VS Code loads a single file;
  `@secscribe/core` incl. zod is bundled), webview as an IIFE + CSS with a
  nonce CSP. `mocha` stays external in both test bundles so the runner and
  suites share one instance.
- **Prompt resolution in bundles**: core's engine now locates
  `prompts/review-system.md` via `import.meta.url` with a `__dirname`
  fallback (esbuild CJS bundles replace `import.meta.url` with `undefined`,
  and `__dirname` is a module-scoped CJS binding, not a global). The vscode
  build copies the prompt to `packages/vscode/prompts/` next to the bundle.
- **autoReviewOnSave** is wired in M3 (see below).
- Root vitest excludes `packages/vscode/**` (its tests import the ambient
  `vscode` module and run under @vscode/test-electron instead).

## VS Code extension (M3)

- **Assisted apply (`applyMode: "assist"`)**: one "Apply fix" click per
  suggestion → the extension re-runs the exact-match search against the live
  document, re-verifies the quoted span, and applies a single `WorkspaceEdit`
  replace. Ambiguous quotes render per-occurrence buttons ("line N"); stale
  quotes refuse with a message. Never bulk, never automatic, never on save;
  in `"self"` mode the handler rejects with "no write path".
- **Applied suggestions** behave like dismissed ones: removed from the panel
  and gutter, recorded as `applied` history.
- **Practice mode**: per-suggestion "Practice this fix" hides the corrected
  sentence, takes the user's typed fix, and grades with core `gradeFix`
  (normalized whitespace/punctuation/case). Wrong/partial fixes get an
  "Add to flashcards" button that stores the corrected phrase as the term
  with the corrected sentence as the source quote (§7c). Practice input
  state survives panel re-renders.
- **Vocabulary tab**: searchable/filterable table (client-side filtering over
  the full card list — fine at v1 card volumes), manual add, delete, and the
  pending-extract confirmations from the latest review. Reviews do NOT
  auto-switch tabs: pending items surface via the tab badge and a status
  message (auto-switching hijacked the Suggestions flow and also broke the
  render-ack contract the tests rely on).
- **Study tab**: session state lives in the extension (StudyController over
  the core store); the webview renders. Space = reveal, 1–4 = rate (keyboard
  handled only while the Study tab is focused and no input is). The summary
  (counts + remaining due) persists until the next session starts — a
  session that self-nulls on completion used to zero its counts before the
  summary could render.
- **Study before any review**: `secscribe.studyNow` synthesizes an empty run
  so Study/Vocabulary work on a fresh window.
- **Status bar**: `$(book) SecScribe: N due`, click = Study now. `secScribe.showStatusBar`
  (default true) hides it — the spec says "can be disabled" without naming a
  key. Refreshed on activation, reviews, vocabulary changes, and study
  ratings.
- **Commands**: `Add selection to vocabulary` (selection trimmed, ≤120 chars,
  single line; source quote = the containing line), `Study now`, `Export
  Anki CSV` (Save dialog, or a direct Uri when invoked programmatically —
  how the smoke test drives it headless), `Open settings`
  (`@ext:secscribe.secscribe`).
- **autoReviewOnSave** is wired: saving an active Markdown file triggers a
  (debounced 800 ms) review — reviews only, nothing is ever applied.
- **Rendered ack**: the webview posts `rendered` (suggestion count) after
  EVERY render regardless of the visible tab, so the extension/tests can
  always observe the current suggestions state.
- **Config diagnostics**: the activation-time layer log redacts the API key
  (`"***set***"`) — it briefly printed the real home key to the extension
  host log, violating acceptance #6.

## Testing

- **Property test** uses an adversarial in-process LLM (seeded PRNG) that
  quotes arbitrary raw document spans (including code) and returns
  placeholder-shaped replacements and occasional invalid JSON; asserts every
  original protected text survives byte-for-byte after applying all accepted
  suggestions, no applied edit range touches a protection, and frontmatter
  stays at byte 0.
- **Fake OpenAI server** (`core/test/helpers/fake-server.ts`) records requests
  (auth header, body) and serves scripted/dynamic completions; shared by core
  engine tests and CLI e2e tests (the CLI e2e spawns the built
  `packages/cli/dist/index.js`).
