/**
 * Reconstructs the commit history behind both sides of a conflict hunk so the
 * LLM layer can explain *why* each side changed, not just *what* differs.
 *
 * We pull whole-file history per side rather than line-scoped history: the
 * marker line numbers refer to the merged working tree, which does not map
 * cleanly onto either parent's line ranges, and whole-file `git log` is both
 * reliable and rich enough for narrative context. The incoming side may not
 * contain the file at all (e.g. a file added on only one side), in which case
 * that side simply has no history.
 */

import { getLogForRange, getConflictInfo } from '../git/gitClient.js';
import { GitCommandError } from '../git/gitClient.js';
import type { ConflictedFile, HunkContext } from '../types/index.js';

const DEFAULT_MAX_COMMITS = 10;

async function safeLog(
  filePath: string,
  ref: string,
  maxCount: number,
  cwd: string,
): Promise<import('../types/index.js').CommitInfo[]> {
  try {
    return await getLogForRange(filePath, ref, maxCount, cwd);
  } catch (error) {
    // A missing file on one side is expected (add/add or add/delete conflicts);
    // treat it as "no history" rather than failing the whole run.
    if (error instanceof GitCommandError) return [];
    throw error;
  }
}

/**
 * Gathers head and incoming commit history for a conflicted file. Every hunk in
 * a file shares the same file-level history, so callers can compute this once
 * per file and reuse it across the file's hunks.
 */
export async function getHunkContext(
  file: ConflictedFile,
  cwd: string = process.cwd(),
  maxCount: number = DEFAULT_MAX_COMMITS,
): Promise<HunkContext> {
  const { incomingRef } = await getConflictInfo(cwd);
  const [headCommits, incomingCommits] = await Promise.all([
    safeLog(file.path, 'HEAD', maxCount, cwd),
    safeLog(file.path, incomingRef, maxCount, cwd),
  ]);
  return { headCommits, incomingCommits };
}
