import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHunkContext } from '../../src/core/history.js';
import type { ConflictedFile } from '../../src/types/index.js';

describe('getHunkContext', () => {
  let repo: string;
  const file = 'greet.js';

  const git = (args: string[]) => execa('git', args, { cwd: repo });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-hist-'));
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

    await git(['merge', 'feature']).catch(() => undefined);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('separates head and incoming history for a real conflict', async () => {
    const file0: ConflictedFile = {
      path: file,
      content: await readFile(join(repo, file), 'utf8'),
      hunks: [],
    };

    const context = await getHunkContext(file0, repo);

    expect(context.headCommits.map((c) => c.subject)).toContain('feat: greet says hey from main');
    expect(context.incomingCommits.map((c) => c.subject)).toContain(
      'feat: greet says hello from feature',
    );
    // The shared ancestor commit shows up in both histories.
    expect(context.headCommits.map((c) => c.subject)).toContain('feat: add greet returning hi');
  });
});
