import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExplain } from '../../src/cli/explain.js';

describe('runExplain', () => {
  let repo: string;
  const file = 'greet.js';

  const git = (args: string[]) => execa('git', args, { cwd: repo });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-cli-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@test.local']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'commit.gpgsign', 'false']);

    await writeFile(join(repo, file), 'function greet() {\n  return "hi";\n}\n');
    await git(['add', file]);
    await git(['commit', '-m', 'feat: add greet']);

    await git(['checkout', '-b', 'feature']);
    await writeFile(join(repo, file), 'function greet() {\n  return "hello from feature";\n}\n');
    await git(['commit', '-am', 'feat: feature greeting']);

    await git(['checkout', 'main']);
    await writeFile(join(repo, file), 'function greet() {\n  return "hey from main";\n}\n');
    await git(['commit', '-am', 'feat: main greeting']);

    await git(['merge', 'feature']).catch(() => undefined);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('runs the flow and prints the mocked narrative per hunk', async () => {
    const narrate = vi.fn().mockResolvedValue('Both sides changed the greeting text.');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runExplain({ cwd: repo, narrate, spinner: false });

    expect(narrate).toHaveBeenCalledOnce();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Both sides changed the greeting text.');
    expect(printed).toContain(file);

    logSpy.mockRestore();
  });

  it('throws when no merge or rebase is in progress', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'cc-clean-'));
    await execa('git', ['init', '-b', 'main'], { cwd: clean });
    await expect(runExplain({ cwd: clean, spinner: false })).rejects.toThrow(/no merge or rebase/i);
    await rm(clean, { recursive: true, force: true });
  });
});
