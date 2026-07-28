/**
 * The single point of contact between conflict-context and the git binary.
 * Nothing outside this file may shell out to git. Every command that exits
 * non-zero is turned into a {@link GitCommandError} carrying stderr, so callers
 * never see a raw rejection from execa.
 */

import { execa } from 'execa';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitInfo, BlameLine } from '../types/index.js';


export class GitCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | undefined,
    public readonly stderr: string,
  ) {
    super(`git command failed: ${command}\n${stderr}`.trim());
    this.name = 'GitCommandError';
  }
}

/** Fields separated within a commit record; group separator between records. */
const FIELD = '\x1f';
const RECORD = '\x1e';

async function runGit(args: string[], cwd: string = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execa('git', args, { cwd });
    return stdout;
  } catch (error) {
    const e = error as { exitCode?: number; stderr?: string; shortMessage?: string };
    throw new GitCommandError(
      `git ${args.join(' ')}`,
      e.exitCode,
      e.stderr ?? e.shortMessage ?? String(error),
    );
  }
}

/** For sibling modules in src/git/ only — everything else goes through the typed API. */
export { runGit };

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function gitDir(cwd: string = process.cwd()): Promise<string> {
  const dir = await runGit(['rev-parse', '--absolute-git-dir'], cwd);
  return dir.trim();
}

export { gitDir };

/**
 * True when a merge or rebase is mid-flight. A merge leaves MERGE_HEAD; an
 * interactive/apply rebase leaves a rebase-merge or rebase-apply directory.
 */
export async function isMergeOrRebaseInProgress(cwd: string = process.cwd()): Promise<boolean> {
  const dir = await gitDir(cwd);
  const [merge, rebaseMerge, rebaseApply] = await Promise.all([
    exists(join(dir, 'MERGE_HEAD')),
    exists(join(dir, 'rebase-merge')),
    exists(join(dir, 'rebase-apply')),
  ]);
  return merge || rebaseMerge || rebaseApply;
}

export async function getConflictedFiles(cwd: string = process.cwd()): Promise<string[]> {
  const stdout = await runGit(['diff', '--name-only', '--diff-filter=U'], cwd);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Identifies the in-progress operation and the ref naming the incoming side of
 * the conflict. For a merge that is MERGE_HEAD; during a rebase the commit
 * being replayed is REBASE_HEAD.
 */
export async function getConflictInfo(
  cwd: string = process.cwd(),
): Promise<{ operation: 'merge' | 'rebase'; incomingRef: string }> {
  const dir = await gitDir(cwd);
  if (await exists(join(dir, 'MERGE_HEAD'))) {
    return { operation: 'merge', incomingRef: 'MERGE_HEAD' };
  }
  return { operation: 'rebase', incomingRef: 'REBASE_HEAD' };
}

/** Reads the working-tree file, which for a conflicted file still holds markers. */
export async function getFileContent(
  filePath: string,
  cwd: string = process.cwd(),
): Promise<string> {
  return readFile(join(cwd, filePath), 'utf8');
}

export async function writeFileContent(
  filePath: string,
  content: string,
  cwd: string = process.cwd(),
): Promise<void> {
  await writeFile(join(cwd, filePath), content);
}

export async function stageFile(filePath: string, cwd: string = process.cwd()): Promise<void> {
  await runGit(['add', '--', filePath], cwd);
}

/** Reads the local git user.name; falls back to 'unknown' when not configured. */
export async function getGitUserName(cwd: string = process.cwd()): Promise<string> {
  try {
    const name = await runGit(['config', 'user.name'], cwd);
    return name.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseLog(stdout: string): CommitInfo[] {
  return stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, author, date, subject, message, ...patchParts] = record.split(FIELD);
      const diff = patchParts.join(FIELD).trim();
      return {
        hash: (hash ?? '').trim(),
        author: (author ?? '').trim(),
        date: (date ?? '').trim(),
        subject: (subject ?? '').trim(),
        message: (message ?? '').trim(),
        ...(diff ? { diff } : {}),
      } satisfies CommitInfo;
    });
}

/**
 * Commit history (with patches) for one file on a given ref. Returns newest
 * first, capped at `maxCount`. Each {@link CommitInfo} carries a short diff
 * snippet for that file.
 */
export async function getLogForRange(
  filePath: string,
  ref: string,
  maxCount: number,
  cwd: string = process.cwd(),
): Promise<CommitInfo[]> {
  const format = `${RECORD}%H${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%B${FIELD}`;
  const stdout = await runGit(
    ['log', `-n${maxCount}`, '-p', `--format=${format}`, ref, '--', filePath],
    cwd,
  );
  return parseLog(stdout);
}

/**
 * Per-line blame over a range on a given ref. Uses porcelain output so the
 * hash and author survive without locale-dependent formatting.
 */
export async function getBlame(
  filePath: string,
  ref: string,
  startLine: number,
  endLine: number,
  cwd: string = process.cwd(),
): Promise<BlameLine[]> {
  const stdout = await runGit(
    ['blame', '-L', `${startLine},${endLine}`, '--line-porcelain', ref, '--', filePath],
    cwd,
  );

  const lines: BlameLine[] = [];
  let hash = '';
  let author = '';
  let lineNumber = startLine;

  for (const line of stdout.split('\n')) {
    const header = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(line);
    if (header) {
      hash = header[1] ?? '';
      lineNumber = Number(header[2]);
    } else if (line.startsWith('author ')) {
      author = line.slice('author '.length);
    } else if (line.startsWith('\t')) {
      lines.push({ lineNumber, hash, author });
    }
  }
  return lines;
}
