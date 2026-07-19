# conflict-context (`cctx`)

![conflict-context — resolve git merge conflicts by understanding why each side changed](https://raw.githubusercontent.com/ijatinydv/conflict-resolver/main/assets/banner.png)

[![npm version](https://img.shields.io/npm/v/conflict-context.svg)](https://www.npmjs.com/package/conflict-context)
[![CI](https://github.com/ijatinydv/conflict-resolver/actions/workflows/ci.yml/badge.svg)](https://github.com/ijatinydv/conflict-resolver/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/conflict-context.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/conflict-context.svg)](./LICENSE)

> Resolve git merge conflicts by understanding *why* each side changed — not just diffing text.

You come back to a branch after a week (or your AI agent wrote it overnight), rebase, and hit
a wall of conflict markers. The problem isn't picking lines — it's that you've **lost the
context**: you no longer remember why either side made its change. Every AI merge tool shows
you two versions of a hunk and asks you to choose. `conflict-context` first reconstructs the
intent behind each side from commit history and code structure, explains it in plain English,
and only then proposes a merge — with a confidence score you can gate on.

## Before / after

What git gives you:

```
<<<<<<< HEAD
  if (input == null) return "";
  return input.trim();
=======
  return input.trim().toLowerCase();
>>>>>>> feature
```

What `cctx resolve` gives you:

```
parser.js  (lines 2-7) — hunk 1/1
Main hardened parse() against null input (commit "fix: guard parser against
null input"); the feature branch normalizes output to lowercase (commit
"feat: normalize parser output to lowercase"). Independent changes to the
same function — both intents can be kept.

Proposed vs OURS (HEAD):
  if (input == null) return "";
- return input.trim();
+ return input.trim().toLowerCase();

Confidence: high — Both changes are complementary and compose cleanly. [logic-conflict]
[a]ccept / [e]dit manually / [s]kip?
```

## Install

Requires **Node.js 20+** and **git** on your `PATH`.

```
npm install -g conflict-context
```

This installs two commands — `conflict-context` and the short alias **`cctx`** — that work
identically. Every example below uses `cctx`.

Then configure **one** LLM provider key, via an environment variable or a `.env` file in the
repo you run it from:

| Provider | Key | Model override (optional) |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`) |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` (default `gpt-4o`) |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` (default `gemini-2.0-flash`) |

Keys are auto-detected in that order; set `LLM_PROVIDER` to force one explicitly. Your key is
read locally and sent only to the provider you chose — it never passes through any server of
ours.

## Quick start

```bash
# 1. install once
npm install -g conflict-context

# 2. point it at a provider (any one of the three)
echo "ANTHROPIC_API_KEY=sk-..." > .env

# 3. hit a conflict, then understand it before touching a line
git merge feature        # ...CONFLICT
cctx explain             # plain-English: what each side was doing, and why

# 4. resolve interactively, with a confidence score per hunk
cctx resolve             # accept / edit / skip each proposal

# 5. changed your mind? roll back everything resolve touched
cctx undo
```

## Usage

Run inside a repo that is mid-merge or mid-rebase.

### `cctx explain`

Prints a plain-English narrative per conflicted hunk — what each side was trying to do and
whether the changes are related. Read-only, touches nothing.

### `cctx resolve`

Proposes a merged resolution per hunk with colorized diffs against both sides and a
confidence score, then asks you to choose:

| Key | Choice | What happens |
| --- | --- | --- |
| `a` | **accept** | the proposed code replaces this conflict when the file is written |
| `e` | **edit** | the proposal opens in `$EDITOR` (or an inline prompt, end with a lone `.` line); your edited version is applied instead |
| `s` | **skip** | this hunk is left exactly as-is — markers stay, file stays unmerged |

Files are written once, after all their hunks are decided. Files with no markers left are
`git add`ed automatically; files with skipped hunks are left unstaged. A safety snapshot is
always taken first.

| Flag | Effect |
| --- | --- |
| `--auto` | apply hunks at or above `--min-confidence` without prompting |
| `--min-confidence <high\|medium\|low>` | threshold for `--auto` (default `high`) |
| `--dry-run` | walk the whole flow, write nothing |
| `--file <path>` | scope to one conflicted file |
| `--no-color` | plain output |

### `cctx undo`

Restores every touched file — content *and* unmerged index state — to exactly how it was
before `resolve` ran. Works even mid-rebase; the snapshot never disturbs git's merge
machinery.

## How it's different

| | conflict-context | GitLens / GitKraken AI | generic AI merge tools |
| --- | --- | --- | --- |
| Recovers *why* each side changed (history + blame) | ✅ core feature | ❌ diff-only view | ❌ diff-only prompt |
| AST-aware context (whole enclosing function, not ±3 lines) | ✅ tree-sitter | ➖ editor context | ❌ |
| Offline heuristics ground the confidence score | ✅ formatting/imports/renames | ❌ | ❌ |
| Auto-apply with a confidence gate | ✅ `--auto --min-confidence` | ➖ manual accept | ➖ varies |
| Undo that restores unmerged index state | ✅ `undo` | ➖ editor undo | ❌ |
| Bring your own provider (Anthropic / OpenAI / Gemini) | ✅ | ❌ vendor-fixed | ➖ varies |
| Works in CI / terminal, no editor required | ✅ CLI | ❌ editor extension | ➖ varies |

The honest caveat: editor extensions integrate with your existing UI; this is a standalone
CLI by design, so it composes with any workflow (including agents) but doesn't live in your
editor.

## How it works

1. **Detect** — parse conflict markers (diff2 and diff3) into structured hunks.
2. **Recover context** — `git log`/blame both HEAD and the incoming ref per file; tree-sitter
   finds the enclosing function/method/class for each hunk.
3. **Classify offline** — formatting-only, import-ordering, and pure-rename conflicts are
   detected heuristically before any API call, and floor the confidence score.
4. **Propose** — the model gets both sides, both histories, and the AST context, and returns
   a strict-JSON resolution with narrative and confidence.
5. **Apply safely** — snapshot first, write whole files only after all their hunks are
   decided, stage only marker-free files, `undo` rolls everything back.

## Development

```
git clone https://github.com/ijatinydv/conflict-resolver
cd conflict-resolver
npm install
npm run build && npm test && npm run lint
npm link            # try the cctx command against a local checkout
```

Issues and pull requests welcome at
[github.com/ijatinydv/conflict-resolver](https://github.com/ijatinydv/conflict-resolver). See
[CONTRIBUTING.md](https://github.com/ijatinydv/conflict-resolver/blob/main/CONTRIBUTING.md) for
setup, project layout, conventions, and the PR checklist before you start.

## License

[MIT](./LICENSE) © ijatinydv
