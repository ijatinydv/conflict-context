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
import { getEnclosingContext } from '../core/chunker.js';
import { getResolution } from '../core/llm.js';
import { classifyHunk, applyConfidenceFloor } from '../core/confidence.js';
import { applyHunkEdits, hasConflictMarkers } from '../core/applier.js';
import { renderDiff } from '../utils/diffRender.js';
import { log } from '../utils/logger.js';
import type {
  AskFn,
  Choice,
  ConflictHunk,
  HunkDecision,
  HunkEdit,
  ResolveOptions,
  Resolution,
} from '../types/index.js';


const CONFIDENCE_COLOR = {
  high: chalk.green,
  medium: chalk.yellow,
  low: chalk.red,
} as const;

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

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
  const dryRun = options.dryRun === true;

  if (!(await isMergeOrRebaseInProgress(cwd))) {
    throw new Error('No merge or rebase in progress — nothing to resolve.');
  }

  let files = await getConflictedFiles(cwd);
  if (options.file) files = files.filter((f) => f === options.file);

  if (files.length > 0 && !dryRun) {
    await createSnapshot(cwd);
    log.info('Safety snapshot created — `cctx undo` restores the pre-resolve state.');
  }
  if (dryRun) log.info('Dry run: no files will be written, staged, or snapshotted.');

  // Ctrl+C safety: files are only written in one shot after all their hunks
  // are decided, so an interrupt simply abandons the in-flight file — nothing
  // is ever half-written, and the snapshot (when not dry-running) still holds.
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    log.warn('\nInterrupted — finishing without writing the current file. Snapshot is intact.');
  };
  process.on('SIGINT', onSigint);

  const decisions: HunkDecision[] = [];

  try {
    for (const [fileIndex, path] of files.entries()) {
      if (interrupted) break;
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

      log.info(
        `\nFile ${fileIndex + 1}/${files.length}: ${path} — ${hunks.length} conflicted hunk(s)`,
      );

      const context = await getHunkContext({ path, content, hunks }, cwd);
      const edits: HunkEdit[] = [];

      for (const [hunkIndex, hunk] of hunks.entries()) {
        if (interrupted) break;
        log.rule();
        log.heading(
          `${path}  (lines ${hunk.startLine}-${hunk.endLine}) — hunk ${hunkIndex + 1}/${hunks.length}`,
        );

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
        log.info(
          renderDiff(
            'Proposed vs OURS (HEAD):',
            hunk.headOriginLines.join('\n'),
            resolution.proposedCode,
          ),
        );
        log.info(
          renderDiff(
            'Proposed vs THEIRS (incoming):',
            hunk.incomingLines.join('\n'),
            resolution.proposedCode,
          ),
        );
        const paint = CONFIDENCE_COLOR[resolution.confidence];
        log.info(
          `Confidence: ${paint(resolution.confidence)} — ${resolution.confidenceReason} [${classification}]`,
        );

        const minConfidence = options.minConfidence ?? 'high';
        const autoApplicable =
          options.auto === true &&
          CONFIDENCE_RANK[resolution.confidence] >= CONFIDENCE_RANK[minConfidence];

        let choice: Choice;
        if (autoApplicable) {
          choice = 'auto';
          log.info(`Auto-applied (>= ${minConfidence} confidence).`);
        } else {
          choice = await promptChoice(ask);
        }

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
          applied: choice !== 'skip' && !dryRun,
        });
      }

      // Write once per file, after every hunk is decided — an interrupt mid-file
      // abandons the whole file rather than leaving it half-written.
      if (edits.length > 0 && !interrupted && !dryRun) {
        const resolved = applyHunkEdits(content, edits);
        await writeFileContent(path, resolved, cwd);
        if (!hasConflictMarkers(resolved)) {
          await stageFile(path, cwd);
          log.info(`${path}: all hunks resolved — staged with git add.`);
        } else {
          log.warn(`${path}: some hunks skipped — conflict markers remain, file not staged.`);
        }
      } else if (edits.length > 0 && dryRun) {
        log.info(`${path}: would apply ${edits.length} hunk(s) (dry run).`);
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
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
  const count = (c: Choice) => decisions.filter((d) => d.choice === c).length;
  log.info(
    `${count('auto')} auto-applied, ${count('accept')} accepted manually, ` +
      `${count('edit')} edited, ${count('skip')} skipped. ` +
      'Run `cctx undo` to roll back.',
  );
}
