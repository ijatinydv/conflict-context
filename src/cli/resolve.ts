/**
 * Orchestrates the `resolve` flow. Phase 2 scope: propose a resolution per
 * hunk and record the user's accept/edit/skip choice — nothing is written to
 * disk yet. Both the LLM proposal and the interactive prompt are injectable
 * for testing.
 */

import { createInterface } from 'node:readline/promises';
import ora from 'ora';
import chalk from 'chalk';
import {
  isMergeOrRebaseInProgress,
  getConflictedFiles,
  getFileContent,
} from '../git/gitClient.js';
import { parseConflicts, ConflictParseError } from '../core/detector.js';
import { getHunkContext } from '../core/history.js';
import { getEnclosingContext, type EnclosingContext } from '../core/chunker.js';
import { getResolution } from '../core/llm.js';
import { classifyHunk, applyConfidenceFloor } from '../core/confidence.js';
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

export interface ResolveOptions {
  cwd?: string;
  file?: string;
  propose?: ProposeFn;
  ask?: AskFn;
  spinner?: boolean;
}

export interface HunkDecision {
  file: string;
  startLine: number;
  endLine: number;
  choice: Choice;
  confidence: Resolution['confidence'];
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
  const useSpinner = options.spinner ?? true;

  if (!(await isMergeOrRebaseInProgress(cwd))) {
    throw new Error('No merge or rebase in progress — nothing to resolve.');
  }

  let files = await getConflictedFiles(cwd);
  if (options.file) files = files.filter((f) => f === options.file);

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

    for (const hunk of hunks) {
      log.rule();
      log.heading(`${path}  (lines ${hunk.startLine}-${hunk.endLine})`);

      const classification = classifyHunk(hunk);
      const astContext = await getEnclosingContext(
        `${cwd}/${path}`,
        hunk.startLine,
        hunk.endLine,
      );

      const spinner = useSpinner ? ora('Proposing resolution…').start() : undefined;
      let resolution: Resolution;
      try {
        resolution = await propose(hunk, context, astContext, classification);
        spinner?.stop();
      } catch (error) {
        spinner?.fail('Could not propose a resolution');
        log.error(`  ${error instanceof Error ? error.message : String(error)}`);
        decisions.push({ ...lineRange(hunk), file: path, choice: 'skip', confidence: 'low' });
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
      decisions.push({ ...lineRange(hunk), file: path, choice, confidence: resolution.confidence });
    }
  }

  printSummary(decisions);
  return decisions;
}

function lineRange(hunk: ConflictHunk): { startLine: number; endLine: number } {
  return { startLine: hunk.startLine, endLine: hunk.endLine };
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
  log.info(
    `Nothing was written to disk — applying resolutions arrives in a later phase.`,
  );
}
