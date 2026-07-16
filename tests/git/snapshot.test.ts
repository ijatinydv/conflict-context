import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot, restoreSnapshot, hasSnapshot } from '../../src/git/snapshot.js';
import { GitCommandError } from '../../src/git/gitClient.js';

describe('snapshot and undo', () => {
  let repo: string;
  const file = 'greet.js';

  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: repo, ...(input === undefined ? {} : { input }) });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-snap-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@test.local']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'commit.gpgsign', 'false']);

    await writeFile(join(repo, file), 'function greet() {\n  return "hi";\n}\n');
    await git(['add', file]);
    await git(['commit', '-m', 'base']);
    await git(['checkout', '-b', 'feature']);
    await writeFile(join(repo, file), 'function greet() {\n  return "feature";\n}\n');
    await git(['commit', '-am', 'feature change']);
    await git(['checkout', 'main']);
    await writeFile(join(repo, file), 'function greet() {\n  return "main";\n}\n');
    await git(['commit', '-am', 'main change']);
    await git(['merge', 'feature']).catch(() => undefined);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('restores working tree and unmerged index exactly after a simulated resolve', async () => {
    const originalContent = await readFile(join(repo, file), 'utf8');
    const originalUnmerged = (await git(['ls-files', '-u'])).stdout;
    expect(originalContent).toContain('<<<<<<<');

    await createSnapshot(repo);
    expect(await hasSnapshot(repo)).toBe(true);

    // Simulate what resolve's apply step will do: overwrite markers, stage it.
    await writeFile(join(repo, file), 'function greet() {\n  return "merged";\n}\n');
    await git(['add', file]);
    expect((await git(['ls-files', '-u'])).stdout).toBe('');

    const restored = await restoreSnapshot(repo);

    expect(restored).toEqual([file]);
    expect(await readFile(join(repo, file), 'utf8')).toBe(originalContent);
    expect((await git(['ls-files', '-u'])).stdout).toBe(originalUnmerged);
    // merge is still in progress and undo is idempotent-safe: snapshot consumed
    expect(await hasSnapshot(repo)).toBe(false);
  });

  it('throws a clear error when there is no snapshot to restore', async () => {
    await expect(restoreSnapshot(repo)).rejects.toBeInstanceOf(GitCommandError);
    await expect(restoreSnapshot(repo)).rejects.toThrow(/nothing to undo/i);
  });
});
