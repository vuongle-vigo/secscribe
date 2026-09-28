# SecScribe

An English writing assistant and vocabulary coach for a security blogger.
Reviews the English in Markdown posts (never touching code, commands, tool
names, CVE IDs), explains every fix in simple English + Vietnamese, and turns
vocabulary from your own writing into spaced-repetition flashcards with Anki
export.

Local-first: all data stays in your workspace (`.secscribe/`); the only
network peer is the OpenAI-compatible endpoint you configure.

## Packages

| Package | What it is |
| --- | --- |
| `packages/core` | All logic: markdown-safe segmentation, LLM review pipeline, vocabulary, SM-2 SRS, storage |
| `packages/cli` | `secscribe` command-line interface |
| `packages/vscode` | VS Code extension: read-only Suggestions panel + gutter dots (M2) |

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Requirements: Node 20+, pnpm.

## Quick start (CLI)

```bash
# 1. configure an OpenAI-compatible endpoint (suggests Z.ai GLM, OpenAI, …)
secscribe init

# or: export SECSRIBE_API_KEY=…  (key is never written to workspace files)

# 2. review a post — interactive: y apply · n skip · a apply-all · q quit
secscribe review posts/my-writeup.md

secscribe review posts/my-writeup.md --read-only   # print only, never writes
secscribe review posts/my-writeup.md --json        # CI mode (never writes)

# 3. vocabulary
secscribe cards add "reconnaissance"
secscribe cards list
secscribe cards due

# 4. study (cloze flashcards: reveal → rate 1–4)
secscribe study

# 5. export to Anki (File → Import, fields: front, back, tags)
secscribe export anki --out deck.csv

secscribe status   # due counts, cards, ~tokens last 7 days
```

## VS Code extension

```bash
pnpm --filter secscribe build   # bundle to dist/extension.js
```

Run/debug it: open `packages/vscode` in VS Code and press F5 (or "Extensions:
Install from VSIX" after packaging). Commands:

- **SecScribe: Review current file** — reviews the active Markdown post and
  opens the SecScribe panel.
- **SecScribe: Add selection to vocabulary** — select a word/phrase → card.
- **SecScribe: Study now** / **Export Anki CSV** / **Open settings**.

The panel has three tabs:

- **Suggestions** — line number, severity, category, word-level diff, EN+VI
  explanations. Default (`applyMode: "self"`) is read-only: *Copy corrected
  text*, *Go to line* (moves the cursor, never edits), *Dismiss*. With
  `applyMode: "assist"` each item also gets an **Apply fix** button (one
  explicit click, one exact-match edit — never bulk/automatic/on-save).
  With `practiceMode` on, a **Practice** toggle hides the fix and grades
  your typed version (normalized comparison); wrong/partial fixes can
  become flashcards.
- **Vocabulary** — searchable table (term, due state, tags), pending
  extracts from the latest review (Add/Skip each), manual add/delete.
- **Study** — cloze flashcards from your own sentences: Space = reveal,
  1–4 = Again/Hard/Good/Easy, progress bar, session summary.

Plus a gutter dot on lines with pending suggestions
(`secScribe.highlightInEditor`) and a `SecScribe: N due` status bar item
(`secScribe.showStatusBar`). Settings: everything from the spec under the
`secScribe.*` prefix; the API key lives in VS Code SecretStorage (prompted
on first review).

## How code stays safe

Before anything is sent to the LLM, the document is segmented into YAML
frontmatter, fenced code blocks (nested/tilde), inline code, URLs, and raw
HTML — all replaced with opaque placeholders (`⟦C1⟧`, `⟦I2⟧`, …). Any
suggestion that contains a placeholder or whose quoted range touches a
protected segment is rejected. Applying a fix is an exact string match: one
match applies, several ask you to pick the occurrence, zero marks it stale.
A property test (adversarial LLM included) pins this down.

## State (`.secscribe/`, git-ignored)

```
settings.json    # no secrets
vocabulary.json  # cards + SRS state
history.jsonl    # append-only actions
cache.json       # reviewed-sentence hashes (unchanged sentences never re-send)
```

See `DECISIONS.md` for every ambiguity resolved during the build, and
`SPEC.md` for the full spec. MIT license.
