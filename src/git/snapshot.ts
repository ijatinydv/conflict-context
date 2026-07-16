/**
 * Safety snapshot taken before conflict-context writes anything, plus the
 * restore path behind `conflict-context undo`.
 *
 * Why not `git stash create` or a tag: both build a commit from the index,
 * and mid-conflict the index holds *unmerged* entries that commit-building
 * either rejects or silently collapses — and a stash/tag restore would also
 * disturb MERGE_HEAD / rebase state. Instead we snapshot at a lower level:
 * each conflicted file's working-tree bytes (hashed into the object db with
 * `git hash-object -w`) plus its raw unmerged index entries from
 * `git ls-files -u`. Restoring rewrites the file contents and re-injects the
 * unmerged entries via `git update-index --index-info`, leaving the
 * in-progress merge/rebase machinery completely untouched.
 */

import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { runGit, gitDir, getConflictedFiles, GitCommandError } from './gitClient.js';

const SNAPSHOT_FILE = 'conflict-context-snapshot.json';

interface FileSnapshot {
  path: string;
  /** Blob hash of the working-tree content (markers included). */
  contentBlob: string;
  /** Raw `git ls-files -u` lines for this path (mode, blob, stage). */
  indexEntries: string[];
}

interface Snapshot {
  createdAt: string;
  files: FileSnapshot[];
}

async function snapshotPath(cwd: string): Promise<string> {
  return join(await gitDir(cwd), SNAPSHOT_FILE);
}

export async function createSnapshot(cwd: string = process.cwd()): Promise<string> {
  const conflicted = await getConflictedFiles(cwd);
  const unmergedLines = (await runGit(['ls-files', '-u'], cwd)).split('\n').filter(Boolean);

  const files: FileSnapshot[] = [];
  for (const path of conflicted) {
    const contentBlob = (await runGit(['hash-object', '-w', '--', path], cwd)).trim();
    const indexEntries = unmergedLines.filter((line) => line.split('\t')[1] === path);
    files.push({ path, contentBlob, indexEntries });
  }

  const target = await snapshotPath(cwd);
  const snapshot: Snapshot = { createdAt: new Date().toISOString(), files };
  await writeFile(target, JSON.stringify(snapshot, null, 2));
  return target;
}

export async function hasSnapshot(cwd: string = process.cwd()): Promise<boolean> {
  try {
    await readFile(await snapshotPath(cwd), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Restores every snapshotted file's content and unmerged index entries, then
 * deletes the snapshot. Returns the restored paths.
 */
export async function restoreSnapshot(cwd: string = process.cwd()): Promise<string[]> {
  const target = await snapshotPath(cwd);
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(await readFile(target, 'utf8')) as Snapshot;
  } catch {
    throw new GitCommandError(
      'restore snapshot',
      undefined,
      'No conflict-context snapshot found — nothing to undo.',
    );
  }

  for (const file of snapshot.files) {
    // stripFinalNewline:false — restored bytes must match the original exactly.
    const { stdout: content } = await execa('git', ['cat-file', 'blob', file.contentBlob], {
      cwd,
      stripFinalNewline: false,
    });
    await writeFile(join(cwd, file.path), content);

    // Drop whatever staging state resolve created, then re-add the original
    // unmerged entries. `ls-files -u` output is exactly index-info format.
    await runGit(['update-index', '--force-remove', '--', file.path], cwd);
    if (file.indexEntries.length > 0) {
      await execa('git', ['update-index', '--index-info'], {
        cwd,
        input: file.indexEntries.join('\n') + '\n',
      });
    }
  }

  await rm(target, { force: true });
  return snapshot.files.map((f) => f.path);
}
