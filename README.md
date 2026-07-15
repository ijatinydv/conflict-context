# conflict-context

> Resolve git merge/rebase conflicts by understanding *why* each side changed — not just diffing text.

Status: early build (phase 1 in progress). See `docs/prompts/` for the build roadmap and
`CLAUDE.md` for project conventions if you're contributing or extending this with Claude Code.

## Why

Most AI merge-conflict tools show you two versions of a hunk and ask you to pick. That falls
apart the moment you return to a branch after days away, or the branch was written by an AI
agent — you've lost the mental model of *why* either side exists. `conflict-context` reads the
commit history and blame behind each side of a conflict, has an LLM reconstruct the intent in
plain English, and only then proposes a merged resolution with a confidence score.

## Install (once phase 1 ships)

```
npm install -g conflict-context
```

## Usage

Run it from inside a repo that is mid-merge or mid-rebase:

```
cd your-repo-with-conflicts
conflict-context explain
```

For each conflicted hunk it prints a plain-English narrative of what each side
was trying to do, then the raw conflicting code for reference:

```
────────────────────────────────────────────────────────────
src/auth.js  (lines 42-51)
Both sides rewrote the token check. HEAD tightened it to reject expired
tokens (commit "harden session expiry"), while the incoming branch switched
to the new async verifier (commit "move auth to jose"). They touch the same
lines for different reasons — the fixes are complementary, not competing.

Conflicting code:
<<<<<<< HEAD
  if (isExpired(token)) return null;
=======
  if (await verify(token)) return session;
>>>>>>> incoming
```

Flags:

- `--file <path>` — scope to a single conflicted file
- `--no-color` — disable colored output

### resolve

```
conflict-context resolve
```

For each hunk it proposes a merged resolution with a confidence score
(`high`/`medium`/`low`, grounded by offline heuristics for formatting-only,
import-ordering, and rename conflicts) and asks you to **[a]ccept**,
**[e]dit**, or **[s]kip**. Choices are summarized at the end; nothing is
written to disk yet — auto-apply lands in phase 3. Takes the same
`--file`/`--no-color` flags as `explain`.

```
────────────────────────────────────────────────────────────
logic.js  (lines 2-6)
Main added a 20% tax to totals while the feature branch rounds them —
independent changes to the same return statement.

Proposed resolution:
  return Math.round((a + b) * 1.2);
Confidence: medium — Both intents combine cleanly but order of operations
is assumed. [logic-conflict]
[a]ccept / [e]dit manually / [s]kip? a
────────────────────────────────────────────────────────────
Summary
  accept  format.js:1-7 (high)
  accept  logic.js:2-6 (medium)
```

Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) in your environment
or a `.env` file first — see `.env.example`.

## Demo

Reproduce the sample scenario in a throwaway repo (useful for recording a demo):

```bash
mkdir cc-demo && cd cc-demo && git init -b main
git config user.email you@example.com && git config user.name You

printf 'function parse(input) {\n  return input.trim();\n}\n' > parser.js
git add parser.js && git commit -m "feat: add basic parser"

git checkout -b feature
printf 'function parse(input) {\n  return input.trim().toLowerCase();\n}\n' > parser.js
git commit -am "feat: normalize parser output to lowercase"

git checkout main
printf 'function parse(input) {\n  if (input == null) return "";\n  return input.trim();\n}\n' > parser.js
git commit -am "fix: guard parser against null input"

git merge feature   # conflict on parser.js

export ANTHROPIC_API_KEY=sk-...   # your key
conflict-context explain
```

The two sides changed the same function for unrelated reasons (a null-guard vs.
output normalization) — a case where the *why* matters more than the diff.
