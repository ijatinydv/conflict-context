# Contributing to conflict-context

Thanks for taking the time to contribute. This guide covers everything you need to go from a
fresh clone to a merged pull request. If anything here is unclear or out of date, that's a bug
in the docs — please open an issue.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [The development loop](#the-development-loop)
- [Coding conventions](#coding-conventions)
- [Testing](#testing)
- [Commit messages](#commit-messages)
- [Opening a pull request](#opening-a-pull-request)
- [Reporting bugs](#reporting-bugs)
- [Suggesting features](#suggesting-features)

## Code of conduct

Be respectful, assume good faith, and keep discussion focused on the work. Harassment or
dismissive behavior toward other contributors isn't welcome here.

## Ways to contribute

You don't have to write code to help:

- **Report a bug** — a clear reproduction is worth a lot (see [Reporting bugs](#reporting-bugs)).
- **Improve docs** — README, this guide, code comments, or examples.
- **Add language support** — the AST chunker currently ships with the JS/TS grammar only;
  wiring up another `tree-sitter` grammar is a great first contribution.
- **Fix a bug or build a feature** — check the [issues](https://github.com/ijatinydv/conflict-resolver/issues)
  for anything labeled `good first issue` or `help wanted`.

If you're planning a large change, open an issue first so we can agree on the approach before
you invest time.

## Development setup

You'll need **Node.js 20 or newer** and **git** on your `PATH`.

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/conflict-resolver
cd conflict-resolver

# 2. Add the upstream remote so you can keep your fork in sync
git remote add upstream https://github.com/ijatinydv/conflict-resolver

# 3. Install dependencies
npm install

# 4. Verify everything is green before you change anything
npm run build && npm test && npm run lint
```

To try the CLI against your local checkout:

```bash
npm link          # makes `cctx` and `conflict-context` point at your working copy
cctx --help
```

For fast iteration without a global link, run the entrypoint directly:

```bash
npm run dev -- explain      # runs src/cli/index.ts through tsx, no build step
```

Running `resolve`/`explain` for real needs one LLM provider key in a `.env` file at the repo
root (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`). **Never commit that file** —
it's already in `.gitignore`. The test suite does not make network calls and needs no key.

## Project layout

```
src/
  cli/      entrypoint, argument parsing, orchestrates the flow
  core/     detector, history extractor, chunker, LLM prompt builder, resolver, confidence
  git/      thin wrapper around git shell commands — nothing else touches child_process
  types/    shared TypeScript interfaces (the single home for shared shapes)
  utils/    logger, error formatting, small helpers
tests/      vitest specs, mirrors the src/ structure one-to-one
assets/     README banner (SVG source + rendered PNG)
```

Two boundaries matter most:

- **All git shell-outs live in `src/git/`.** No other module touches `child_process`/`execa`.
- **All shared types live in `src/types/`.** Define an interface once there and import it
  everywhere; don't redeclare shapes inline in feature modules.

## The development loop

1. Sync your fork and branch off `main`:
   ```bash
   git fetch upstream
   git switch -c feat/short-description upstream/main
   ```
2. Make your change. Keep it focused — one logical change per branch.
3. Add or update tests alongside the code (see [Testing](#testing)).
4. Run the full check the CI runs, in order:
   ```bash
   npm run build      # tsc, strict mode — must have zero errors
   npm test           # vitest — all specs must pass
   npm run lint       # eslint — fix or justify any warnings
   npm run format     # prettier — auto-formats src/
   ```
5. Commit (see [Commit messages](#commit-messages)) and push to your fork.
6. Open a pull request against `main`.

CI runs `build`, `test`, and `lint` on every PR against `main`. If those pass locally, they'll
pass in CI.

## Coding conventions

- **Strict TypeScript.** No `any` unless genuinely unavoidable — and if so, add a comment
  explaining why.
- **Errors are typed.** A git command that fails becomes a `GitCommandError`; a raw stack trace
  should never reach the user's terminal. Follow the existing typed-error pattern
  (`GitCommandError`, `ConflictParseError`, `LLMResponseError`, `ProviderError`).
- **Keep detection pure and offline.** No network/LLM calls inside `src/git/` or
  `src/core/detector.ts` — those layers must stay unit-testable without a key.
- **Never hardcode a model string** outside the provider layer; models come from env with a
  documented default.
- **Small, single-purpose functions.** Readability is a first-class goal here.
- **Formatting is not a judgment call** — prettier owns it (single quotes, trailing commas,
  100-char width). Run `npm run format` and let it decide.
- **Match the surrounding code.** New code should read like the file it lives in.

## Testing

- The project uses [vitest](https://vitest.dev/). `tests/` mirrors `src/` one-to-one — a change
  in `src/core/confidence.ts` belongs with `tests/core/confidence.test.ts`.
- Every new module or feature ships with tests; every bug fix ships with a test that fails
  before the fix and passes after.
- Prefer dependency injection over network mocks. The CLI orchestrators take injectable
  function types (`ProposeFn`, `AskFn`, `EditFn`, `NarrateFn`) precisely so tests can script
  behavior without hitting a provider — follow that pattern.

```bash
npm test              # run everything once
npm run test:watch    # re-run on change while developing
```

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/), one logical change per
commit. Prefix the subject with the type:

| Type | For |
| --- | --- |
| `feat:` | a new capability |
| `fix:` | a bug fix |
| `test:` | tests only |
| `docs:` | README/docs only |
| `refactor:` | no behavior change |
| `chore:` | tooling, config, dependencies |

Guidelines:

- Keep the subject under ~70 characters, imperative mood ("add", not "added").
- When the change isn't self-evident, add a body explaining **why**, not just what.
- Stage only the files relevant to the change; review `git status` before `git add`.
- Don't commit `.env`, `node_modules/`, or build output.

Example:

```
feat: add Python grammar to the AST chunker

The chunker only loaded the JS/TS grammar, so conflicts in .py files fell
back to raw-line context. Load the tree-sitter Python grammar and map .py
to it so enclosing-function detection works there too.
```

## Opening a pull request

- Target the `main` branch.
- Give the PR a concise title (Conventional Commit style is ideal) and a description covering:
  **what** changed, **why**, and **how you tested it**.
- Link any related issue (`Closes #123`).
- Make sure `build`, `test`, and `lint` all pass — CI will check, but a green local run saves a
  round trip.
- Keep PRs focused. Several small, reviewable PRs beat one sprawling one. Unrelated cleanups
  belong in their own PR.
- Be ready for review feedback — it's about the code, not you. Push follow-up commits to the
  same branch; we squash on merge where it makes sense.

## Reporting bugs

Open an [issue](https://github.com/ijatinydv/conflict-resolver/issues) with:

- What you ran (the exact `cctx` command and flags).
- What you expected vs. what happened (include the terminal output).
- Your environment: OS, `node --version`, `git --version`, and the package version.
- A minimal reproduction if you can — even a tiny repo with a staged conflict helps enormously.

Please don't paste API keys or private code into an issue.

## Suggesting features

Open an issue describing the problem you're trying to solve, not just the solution you have in
mind — the underlying need often points to a better design. Mention how it fits the project's
focus: recovering *why* each side changed before proposing a merge.

---

Thanks again for contributing. Every issue, doc fix, and pull request makes the tool better.
