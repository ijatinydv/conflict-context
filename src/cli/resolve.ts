/**
 * Orchestrates the `resolve` flow: per hunk, classify offline, pull history
 * and AST context, get a structured LLM proposal, then let the user accept,
 * edit, or skip. Accepted/edited hunks are applied to disk after each file
 * (bottom-up via applier.ts), and fully-resolved files are staged. A safety
 * snapshot (see git/snapshot.ts) is always created before any write; undo
 * restores it. LLM, prompt, and editor interactions are injectable for tests.
 */

import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import {
  isMergeOrRebaseInProgress,
  getConflictedFiles,
  getFileContent,
  writeFileContent,
  stageFile,
} from '../git/gitClient.js';
import { createSnapshot } from '../git/snapshot.js';
import { parseConflicts, ConflictParseError } from '../core/detector.js';
import { getHunkContext } from '../core/history.js';
import { getEnclosingContext, type EnclosingContext } from '../core/chunker.js';
import { getResolution } from '../core/llm.js';
import { classifyHunk, applyConfidenceFloor } from '../core/confidence.js';
import { applyHunkEdits, hasConflictMarkers, type HunkEdit } from '../core/applier.js';
import { log } from '../utils/logger.js';
import type { ConflictHunk, HunkContext, Resolution } from '../types/index.js';

export type Choice = 'accept' | 'edit' | 'skip';

export type ProposeFn = (
  hunk: ConflictHunk,
  context: HunkContext,
  astContext: EnclosingContext,
  classificationHint?: string,
) => Promise<Resolution>;

/** Asks the user for a choice; injectable so tests can script answers. */
export type AskFn = (question: string) => Promise<string>;

/** Lets the user rework proposed code; injectable so tests avoid $EDITOR. */
export type EditFn = (proposedCode: string) => Promise<string>;

export interface ResolveOptions {
  cwd?: string;
  file?: string;
  propose?: ProposeFn;
  ask?: AskFn;
  edit?: EditFn;
  spinner?: boolean;
}

export interface HunkDecision {
  file: string;
  startLine: number;
  endLine: number;
  choice: Choice;
  confidence: Resolution['confidence'];
  applied: boolean;
}

const CONFIDENCE_COLOR = {
  high: chalk.green,
  medium: chalk.yellow,
  low: chalk.red,
} as const;

async function askViaReadline(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Opens $EDITOR on the proposed code; falls back to an inline prompt. */
async function editViaEditor(proposedCode: string): Promise<string> {
  const editor = process.env.EDITOR;
  if (!editor) {
    log.info('($EDITOR is not set — enter replacement code, finish with a single "." line)');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines: string[] = [];
    try {
      for (;;) {
        const line = await rl.question('');
        if (line === '.') break;
        lines.push(line);
      }
    } finally {
      rl.close();
    }
    return lines.join('\n');
  }

  const dir = await mkdtemp(join(tmpdir(), 'conflict-context-'));
  const file = join(dir, 'hunk.txt');
  await writeFile(file, proposedCode);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: 'inherit', shell: true });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${editor} exited with code ${code}`)),
    );
    child.on('error', reject);
  });
  const edited = await readFile(file, 'utf8');
  await rm(dir, { recursive: true, force: true });
  // Editors append a trailing newline; the replacement is spliced between lines.
  return edited.replace(/\r?\n$/, '');
}

async function promptChoice(ask: AskFn): Promise<Choice> {
  for (;;) {
    const answer = (await ask('[a]ccept / [e]dit manually / [s]kip? ')).trim().toLowerCase();
    if (answer === 'a') return 'accept';
    if (answer === 'e') return 'edit';
    if (answer === 's') return 'skip';
    log.warn('Please answer a, e, or s.');
  }
}

export async function runResolve(options: ResolveOptions = {}): Promise<HunkDecision[]> {
  const cwd = options.cwd ?? process.cwd();
  const propose = options.propose ?? getResolution;
  const ask = options.ask ?? askViaReadline;
  const edit = options.edit ?? editViaEditor;
  const useSpinner = options.spinner ?? true;

  if (!(await isMergeOrRebaseInProgress(cwd))) {
    throw new Error('No merge or rebase in progress — nothing to resolve.');
  }

  let files = await getConflictedFiles(cwd);
  if (options.file) files = files.filter((f) => f === options.file);

  if (files.length > 0) {
    await createSnapshot(cwd);
    log.info('Safety snapshot created — `conflict-context undo` restores the pre-resolve state.');
  }

  const decisions: HunkDecision[] = [];

  for (const path of files) {
    const content = await getFileContent(path, cwd);

    let hunks: ConflictHunk[];
    try {
      hunks = parseConflicts(content);
    } catch (error) {
      const reason = error instanceof ConflictParseError ? error.message : String(error);
      log.warn(`Skipping ${path}: ${reason}`);
      continue;
    }
    if (hunks.length === 0) continue;

    const context = await getHunkContext({ path, content, hunks }, cwd);
    const edits: HunkEdit[] = [];

    for (const hunk of hunks) {
      log.rule();
      log.heading(`${path}  (lines ${hunk.startLine}-${hunk.endLine})`);

      const classification = classifyHunk(hunk);
      const astContext = await getEnclosingContext(join(cwd, path), hunk.startLine, hunk.endLine);

      const spinner = useSpinner ? ora('Proposing resolution…').start() : undefined;
      let resolution: Resolution;
      try {
        resolution = await propose(hunk, context, astContext, classification);
        spinner?.stop();
      } catch (error) {
        spinner?.fail('Could not propose a resolution');
        log.error(`  ${error instanceof Error ? error.message : String(error)}`);
        decisions.push({
          file: path,
          startLine: hunk.startLine,
          endLine: hunk.endLine,
          choice: 'skip',
          confidence: 'low',
          applied: false,
        });
        continue;
      }

      resolution = applyConfidenceFloor(resolution, classification);

      log.narrative(resolution.narrative);
      console.log();
      log.info('Proposed resolution:');
      log.code(resolution.proposedCode);
      const paint = CONFIDENCE_COLOR[resolution.confidence];
      log.info(
        `Confidence: ${paint(resolution.confidence)} — ${resolution.confidenceReason} [${classification}]`,
      );

      const choice = await promptChoice(ask);
      let replacement = resolution.proposedCode;
      if (choice === 'edit') replacement = await edit(resolution.proposedCode);
      if (choice !== 'skip') {
        edits.push({ startLine: hunk.startLine, endLine: hunk.endLine, replacement });
      }

      decisions.push({
        file: path,
        startLine: hunk.startLine,
        endLine: hunk.endLine,
        choice,
        confidence: resolution.confidence,
        applied: choice !== 'skip',
      });
    }

    if (edits.length > 0) {
      const resolved = applyHunkEdits(content, edits);
      await writeFileContent(path, resolved, cwd);
      if (!hasConflictMarkers(resolved)) {
        await stageFile(path, cwd);
        log.info(`${path}: all hunks resolved — staged with git add.`);
      } else {
        log.warn(`${path}: some hunks skipped — conflict markers remain, file not staged.`);
      }
    }
  }

  printSummary(decisions);
  return decisions;
}

function printSummary(decisions: HunkDecision[]): void {
  log.rule();
  if (decisions.length === 0) {
    log.warn('No conflicted hunks found for the given scope.');
    return;
  }
  log.heading('Summary');
  for (const d of decisions) {
    log.info(`  ${d.choice.padEnd(6)}  ${d.file}:${d.startLine}-${d.endLine} (${d.confidence})`);
  }
  const applied = decisions.filter((d) => d.applied).length;
  const skipped = decisions.length - applied;
  log.info(`${applied} hunk(s) applied, ${skipped} skipped. Run \`conflict-context undo\` to roll back.`);
}
