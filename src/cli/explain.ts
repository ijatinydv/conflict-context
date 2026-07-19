/**
 * Orchestrates the `explain` flow: detect the conflict, parse each file's
 * hunks, gather per-file history, and emit a plain-English narrative per hunk.
 *
 * The narrative function is injected so the flow can be integration-tested
 * against a real temp repo while mocking only the LLM call. Binary or
 * unparseable files are skipped with a warning rather than crashing the run.
 */

import ora from 'ora';
import {
  isMergeOrRebaseInProgress,
  getConflictedFiles,
  getFileContent,
} from '../git/gitClient.js';
import { parseConflicts, ConflictParseError } from '../core/detector.js';
import { getHunkContext } from '../core/history.js';
import { getNarrative } from '../core/llm.js';
import { log } from '../utils/logger.js';
import type { ConflictHunk, ExplainOptions } from '../types/index.js';


const NUL = String.fromCharCode(0);

/** Heuristic: content containing a NUL byte is binary and cannot be parsed. */
function isBinary(content: string): boolean {
  return content.includes(NUL);
}

export async function runExplain(options: ExplainOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const narrate = options.narrate ?? getNarrative;
  const useSpinner = options.spinner ?? true;

  if (!(await isMergeOrRebaseInProgress(cwd))) {
    throw new Error('No merge or rebase in progress — nothing to explain.');
  }

  let files = await getConflictedFiles(cwd);
  if (options.file) files = files.filter((f) => f === options.file);

  if (files.length === 0) {
    log.warn('No conflicted files found for the given scope.');
    return;
  }

  for (const path of files) {
    const content = await getFileContent(path, cwd);

    if (isBinary(content)) {
      log.warn(`Skipping binary file: ${path}`);
      continue;
    }

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

      const spinner = useSpinner ? ora('Reconstructing intent…').start() : undefined;
      let narrative: string;
      try {
        narrative = await narrate(hunk, context);
        spinner?.succeed('Intent reconstructed');
      } catch (error) {
        spinner?.fail('Could not reconstruct intent');
        log.error(`  ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      log.narrative(narrative);
      console.log();
      log.info('Conflicting code:');
      log.code(
        [
          '<<<<<<< HEAD',
          ...hunk.headOriginLines,
          '=======',
          ...hunk.incomingLines,
          '>>>>>>> incoming',
        ].join('\n'),
      );
    }
  }
}
