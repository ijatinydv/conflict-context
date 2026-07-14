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

```
cd your-repo-with-conflicts
conflict-context resolve
```
