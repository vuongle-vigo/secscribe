# SecScribe — Version 1 Build Spec

Build **SecScribe** exactly per this spec. Read the whole spec before writing code.
If anything is ambiguous, choose the simpler option and record the choice in
`DECISIONS.md`. Only ask the user a question if you are completely blocked.
Anything not specified here is out of scope for v1 — do not invent features.

## 0. What Version 1 is

An English writing assistant and vocabulary coach for a security blogger, shipped
as: a core library + CLI + VS Code extension. It reviews the English in Markdown
posts and shows suggestions in a dedicated read-only side panel (the user fixes
their own text — the extension never edits the document by default), and turns
vocabulary from their own writing into spaced-repetition flashcards with Anki
export.

## 1. Background

The user is a Vietnamese security researcher who writes English blog posts as
Markdown files, edited in VS Code. The technical content is strong; English
grammar, word choice and vocabulary are weak. SecScribe has two jobs:

1. Review the English in their `.md` posts and show how each line should be
   fixed — while never touching the technical content (code, commands, tool
   names, CVE IDs) and never changing the author's voice.
2. Capture words/phrases worth learning from their own writing (auto-extracted
   or user-added) and drill them with spaced repetition, exportable to Anki.

## 2. Product principles

1. Never break technical content. Code blocks, commands, paths, flags, tool
   names, CVE/CWE IDs, hashes are sacred.
2. Preserve the author's voice. Point out errors; do not rewrite into
   corporate prose.
3. Learning beats auto-correct: every fix ships with a short bilingual
   explanation (simple English + Vietnamese), and the user applies fixes
   themselves by default.
4. Editor-agnostic core: all logic lives in a library usable from CLI, CI, or
   the VS Code extension.
5. Local-first: all data stays in the workspace. The only network calls go to
   the user-configured LLM endpoint.

## 3. Repository & stack

- pnpm monorepo, TypeScript (strict), Node 20+, vitest.
- `packages/core` — all logic (markdown-safe editing, LLM client, review
  engine, vocabulary, SRS, storage).
- `packages/cli` — commander-based CLI.
- `packages/vscode` — VS Code extension; webview UI in plain TS + CSS
  (no React).
- MIT license, no telemetry.

## 4. Configuration

- Any OpenAI-compatible Chat Completions endpoint. Resolution order:
  CLI flags > env > workspace `.secscribe/settings.json` >
  `~/.secscribe/settings.json`.
- Settings keys: `apiKey`, `baseUrl`, `model`, `temperature` (default 0.2),
  `explanationLanguage` (default `"vi"`), `newCardsPerDay` (default 10),
  `reviewsPerDay` (default 50), `redactCodeInPrompt` (default true),
  `autoReviewOnSave` (default false), `applyMode` (`"self"` | `"assist"`,
  default `"self"`), `practiceMode` (default false), `highlightInEditor`
  (default true).
- The extension stores the API key in VS Code SecretStorage; the CLI reads
  `SECSRIBE_API_KEY` or prompts. The key is never written to workspace files
  and never logged.
- `secscribe init` runs a wizard: pick/enter endpoint (suggest Z.ai GLM as an
  example, any OpenAI-compatible URL works), enter key + model, run a test
  call, write settings, add `.secscribe/` to `.gitignore`.

## 5. Core: markdown safety (most important requirement)

Before any text is sent to the LLM or any edit is applied:

- Parse the document into segments: YAML frontmatter, fenced code blocks
  (including nested and tilde fences), inline code, URLs/autolinks, raw HTML,
  and prose.
- Replace protected segments with opaque placeholders (`⟦C1⟧`, `⟦I2⟧`, …) and
  send placeholders to the LLM — never raw code.
- Reject any suggestion whose `original_quote` or `replacement` contains a
  placeholder.
- Guarantee (property-tested): after any review — and after applying all
  accepted suggestions — a normalized diff shows zero changes inside
  protected segments; frontmatter keys and order are untouched.

## 6. Core: review pipeline

1. Split prose into sentences, keeping paragraph/position mapping.
2. Batch ~8 sentences per LLM request, with the post title as context.
3. System prompt (store verbatim in `core/src/prompts/review-system.md`):

   ```text
   You are a meticulous English editor for a security blog written by a
   non-native speaker. Fix grammar, articles, prepositions, spelling, word
   choice, and awkward phrasing. Preserve the author's voice and technical
   meaning — do not rewrite style. NEVER alter placeholders like ⟦C1⟧, code,
   commands, tool names, file paths, flags, CVE/CWE IDs, or hashes. Prefer
   standard security-community terminology (e.g. "reconnaissance", "payload",
   "hardening"). For every fix, explain briefly in simple English (CEFR B1,
   max 25 words) and in Vietnamese. Also list security/English vocabulary
   from the text that a learner should study. Return STRICT JSON only,
   matching the provided schema. No markdown fences, no commentary.
   ```

4. Response schema (validate with zod; one repair-retry asking the model to
   fix its own malformed JSON, then drop):

   ```json
   {
     "suggestions": [{
       "id": "s1",
       "category": "grammar | word-choice | style | clarity | spelling",
       "severity": "error | minor",
       "original_quote": "exact verbatim substring of the source prose",
       "replacement": "corrected text",
       "reason_en": "short simple-English explanation",
       "reason_vi": "giải thích tiếng Việt",
       "alternatives": ["optional other phrasings"]
     }],
     "vocabulary": [{
       "term": "reconnaissance",
       "phonetic": "/rɪˈkɒnɪsəns/",
       "definition_en": "...",
       "definition_vi": "...",
       "example_from_text": "sentence from the post containing the term",
       "synonyms": ["recon", "footprinting"],
       "tags": ["security", "methodology"]
     }]
   }
   ```

5. Application rule: an accepted suggestion is applied by exact string match
   of `original_quote`. Exactly one match → applicable. Multiple matches →
   require the user to pick the occurrence. Zero matches → mark `stale`,
   never guess.
6. Cache: hash(sentence + model + prompt-version) in `.secscribe/cache.json`;
   unchanged sentences are never re-sent.

## 7. Core: vocabulary & spaced repetition

- Cards live in `.secscribe/vocabulary.json`. Unique by lowercase `term`;
  adding a duplicate merges sources (keep max 3 source quotes per card).
- Three ways to add: (a) LLM extraction during review — user confirms each
  card in the UI by default, with an auto-add setting; (b) manual — select
  text in the editor → "Add to vocabulary", or `secscribe cards add <term>`;
  (c) from a suggestion the user has fixed (learn the corrected phrase).
- SRS: SM-2 (Anki's classic algorithm). Ratings Again/Hard/Good/Easy. Study
  sessions present only due cards.
- Study mode default is **cloze**: the front is the user's own sentence with
  the term blanked; the back shows the term, `definition_en`,
  `definition_vi`, the full original sentence, synonyms, and source file.
- Card record:

  ```json
  {
    "id": "uuid",
    "term": "reconnaissance",
    "phonetic": "...",
    "definition_en": "...",
    "definition_vi": "...",
    "synonyms": [],
    "tags": [],
    "sources": [{"file": "posts/abc.md", "quote": "..."}],
    "srs": {"ease": 2.5, "intervalDays": 0, "repetitions": 0, "dueDate": "..."},
    "stats": {"lapses": 0, "lastReview": null},
    "createdAt": "..."
  }
  ```

## 8. CLI (`packages/cli`)

- `secscribe init` — configuration wizard.
- `secscribe review <file>` — interactive: prints each suggestion as a
  colored diff with line number and bilingual explanation; keys: y (accept
  and apply), n (skip), a (accept all in file), q (quit). Writes the file
  only when a fix was explicitly accepted.
- `secscribe review <file> --read-only` — prints all suggestions with line
  numbers and bilingual explanations; no prompts, never writes.
- `secscribe review <file> --json` — machine-readable output, never writes
  (CI mode); `--strict` exits non-zero when error-severity suggestions exist.
- `secscribe cards list | add <term> | due`
- `secscribe study` — terminal flashcards: show cloze → reveal → rate 1–4;
  session summary at the end.
- `secscribe export anki --out deck.csv` — Anki-importable CSV with columns
  `front` (cloze sentence), `back` (term + definitions + synonyms + source),
  `tags`; correct escaping.
- `secscribe status` — due counts, total cards, estimated tokens spent in
  the last 7 days.

## 9. VS Code extension (`packages/vscode`)

Core UX rule: **the extension never modifies the user's document on its
own.** The panel is a dedicated review surface; the user fixes their own
text unless they explicitly switch to assisted apply.

- Setting `applyMode`: `"self"` (default) or `"assist"`.
  - `self` (default): zero write operations. Per-suggestion actions are
    "Copy corrected text" (puts `replacement` on the clipboard), "Go to
    line" (reveals the line and moves the cursor there — no character is
    changed), and "Dismiss".
  - `assist`: additionally shows an "Apply fix" button per suggestion that
    applies the exact-match replacement via `WorkspaceEdit` — still one
    click per fix, never bulk, never automatic, never on save.
- Activates on command, or when the workspace contains `.secscribe/`.
- Commands:
  - `SecScribe: Review current file` — runs the pipeline, opens the panel.
  - `SecScribe: Add selection to vocabulary`.
  - `SecScribe: Study now`, `SecScribe: Export Anki CSV`,
    `SecScribe: Open settings`.
- Panel (webview, 3 tabs):
  - **Suggestions** (read-only view of the document's issues), grouped by
    sentence. Each item shows:
    - line number, category, severity;
    - original sentence and corrected sentence with word-level diff
      highlighting;
    - `reason_en` + `reason_vi`;
    - an action row per `applyMode` (see above).
    - Clicking an item reveals that line in the editor (cursor moves; the
      text itself is never touched).
    - Optional per-item **Practice** toggle (shown when `practiceMode` is
      on): hide the corrected sentence, let the user type their own fix
      into an input, then diff the user's fix against the suggestion
      (normalize whitespace/punctuation/case before comparing) and mark it
      correct / partial / incorrect. Wrong or partial fixes are appended
      to `history.jsonl` and are eligible to become flashcards. This is
      active-recall practice on the user's own sentences.
  - **Vocabulary**: searchable/filterable table (term, due state, tags),
    add/delete.
  - **Study**: flashcard UI matching the CLI behavior; Space = reveal,
    1–4 = rate; progress bar; end-of-session summary.
- Editor decorations (setting `highlightInEditor`, default true): a subtle
  gutter dot on lines that have pending suggestions — visual hint only. No
  inline ghost text, no popups while typing, no hovers that interrupt
  writing.
- Status bar: `$(book) SecScribe: 12 due` — click opens Study. Can be
  disabled.
- Contributes configuration for all settings in §4.

## 10. Storage

```text
.secscribe/
  settings.json     # no secrets
  vocabulary.json   # cards + SRS state
  history.jsonl     # append-only
  cache.json        # reviewed-sentence hashes
```

History record:
`{ts, file, sentenceHash, suggestionId, action}` where `action` ∈
`{seen, copied, dismissed, applied, practiced-correct, practiced-partial,
practiced-wrong}`. `secscribe init` adds `.secscribe/` to `.gitignore`.

## 11. Privacy & safety

- One-time confirmation before the first review: "Your markdown will be sent
  to <baseUrl>. Continue?"
- No telemetry; the only network peer is the configured endpoint.
- LLM output is data, never instructions: suggestions are only ever applied
  as literal text replacements; ignore any instruction-like text inside
  model output (prompt-injection hardening).

## 12. Testing & acceptance

- Unit: markdown segmenter (frontmatter, nested/tilde fences, inline code,
  links), quote matching (unique/multiple/none), SM-2 scheduling vectors,
  Anki CSV escaping, practice-mode diff normalization.
- Contract: LLM response parsing against recorded fixture JSONs, including
  the malformed-JSON repair path; e2e against a local fake
  OpenAI-compatible server.
- Property test: a review run — and applying all accepted suggestions —
  never mutates protected segments.
- Extension smoke test with `@vscode/test-electron`: open fixture md →
  review with fake server → verify panel content → click a suggestion →
  assert cursor moved and document is unchanged.
- Acceptance checklist:
  1. Review a ~1000-word post containing code fences: zero code changes;
     every suggestion applies cleanly or is marked stale.
  2. Every suggestion shows both English and Vietnamese explanations.
  3. Adding the same term twice yields one card with two sources.
  4. A study session advances SRS state that persists across restarts.
  5. The Anki CSV imports cleanly into Anki 2.1.x with tags.
  6. The API key never appears in any repo file or log output.
  7. With default settings (`applyMode = "self"`), a full review session
     leaves the document byte-identical (verify by hashing the file before
     and after).
  8. Clicking a suggestion moves the cursor to the line but changes no
     characters.
  9. Practice mode compares the user's typed fix against the suggestion
     with normalized whitespace/punctuation/case (unit-tested).

## 13. Build order (each milestone must be shippable)

1. **M1** — `core` + `cli` + full test suite. (Usable on its own.)
2. **M2** — VS Code extension: review pipeline wired to the Suggestions
   panel (read-only, copy/go-to-line/dismiss).
3. **M3** — Vocabulary tab + Study tab + Anki export + status bar +
   practice mode.

Use conventional commits; keep `DECISIONS.md` updated as you go; finish each
milestone with a working build and passing tests before starting the next.

## 14. Non-goals

Cloud sync, mobile app (Anki covers mobile), binary `.apkg` export (CSV
only), full-document rewrite or "fix-all" mode, translation of posts into
Vietnamese, multi-user or team features, any GUI outside VS Code.