import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitCommandError,
  isMergeOrRebaseInProgress,
  getConflictedFiles,
  getFileContent,
  getLogForRange,
  getBlame,
} from '../../src/git/gitClient.js';

/**
 * These tests run against a real, throwaway git repo with a real merge
 * conflict. We deliberately avoid mocking child_process so the tests catch
 * actual command and output-parsing bugs.
 */
describe('gitClient', () => {
  let repo: string;
  const file = 'greet.js';

  const git = (args: string[]) => execa('git', args, { cwd: repo });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-git-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@test.local']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'commit.gpgsign', 'false']);

    await writeFile(join(repo, file), 'function greet() {\n  return "hi";\n}\n');
    await git(['add', file]);
    await git(['commit', '-m', 'feat: add greet returning hi']);

    await git(['checkout', '-b', 'feature']);
    await writeFile(join(repo, file), 'function greet() {\n  return "hello from feature";\n}\n');
    await git(['commit', '-am', 'feat: greet says hello from feature']);

    await git(['checkout', 'main']);
    await writeFile(join(repo, file), 'function greet() {\n  return "hey from main";\n}\n');
    await git(['commit', '-am', 'feat: greet says hey from main']);

    // Produce the conflict; merge is expected to exit non-zero here.
    await git(['merge', 'feature']).catch(() => undefined);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('detects a merge in progress', async () => {
    expect(await isMergeOrRebaseInProgress(repo)).toBe(true);
  });

  it('lists conflicted files', async () => {
    expect(await getConflictedFiles(repo)).toEqual([file]);
  });

  it('reads working-tree content including conflict markers', async () => {
    const content = await getFileContent(file, repo);
    expect(content).toContain('<<<<<<<');
    expect(content).toContain('>>>>>>>');
  });

  it('parses commit history for a file on a ref', async () => {
    const head = await getLogForRange(file, 'HEAD', 10, repo);
    const subjects = head.map((c) => c.subject);
    expect(subjects).toContain('feat: greet says hey from main');
    expect(head[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head[0]?.diff).toContain('greet');

    const incoming = await getLogForRange(file, 'MERGE_HEAD', 10, repo);
    expect(incoming.map((c) => c.subject)).toContain('feat: greet says hello from feature');
  });

  it('blames a line range on a ref', async () => {
    const blame = await getBlame(file, 'HEAD', 1, 1, repo);
    expect(blame).toHaveLength(1);
    expect(blame[0]?.author).toBe('Test');
    expect(blame[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws a typed GitCommandError on failure', async () => {
    await expect(getBlame('does-not-exist.js', 'HEAD', 1, 1, repo)).rejects.toBeInstanceOf(
      GitCommandError,
    );
  });
});
