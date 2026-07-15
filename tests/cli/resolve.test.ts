import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResolve } from '../../src/cli/resolve.js';
import type { Resolution } from '../../src/types/index.js';

describe('runResolve', () => {
  let repo: string;
  const file = 'calc.js';

  const git = (args: string[]) => execa('git', args, { cwd: repo });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-resolve-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@test.local']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'commit.gpgsign', 'false']);

    await writeFile(join(repo, file), 'function total(a, b) {\n  return a + b;\n}\n');
    await git(['add', file]);
    await git(['commit', '-m', 'feat: add total']);

    await git(['checkout', '-b', 'feature']);
    await writeFile(join(repo, file), 'function total(a, b) {\n  return Math.round(a + b);\n}\n');
    await git(['commit', '-am', 'feat: round totals']);

    await git(['checkout', 'main']);
    await writeFile(join(repo, file), 'function total(a, b) {\n  return (a + b) * 1.2;\n}\n');
    await git(['commit', '-am', 'feat: add 20% tax to totals']);

    await git(['merge', 'feature']).catch(() => undefined);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('proposes per hunk, honours user choices, and writes nothing to disk', async () => {
    const resolution: Resolution = {
      narrative: 'One side rounds, the other taxes.',
      proposedCode: '  return Math.round((a + b) * 1.2);',
      confidence: 'medium',
      confidenceReason: 'Combined both operations.',
    };
    const propose = vi.fn().mockResolvedValue(resolution);
    const ask = vi.fn().mockResolvedValueOnce('x').mockResolvedValueOnce('a'); // invalid then accept
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const before = await execa('git', ['status', '--porcelain'], { cwd: repo });
    const decisions = await runResolve({ cwd: repo, propose, ask, spinner: false });
    const after = await execa('git', ['status', '--porcelain'], { cwd: repo });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ file, choice: 'accept', confidence: 'medium' });
    expect(propose).toHaveBeenCalledOnce();
    // classification hint is passed through to the proposal
    expect(propose.mock.calls[0]![3]).toBe('logic-conflict');
    // re-asks after invalid input
    expect(ask).toHaveBeenCalledTimes(2);
    // nothing applied: working tree unchanged
    expect(after.stdout).toBe(before.stdout);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('One side rounds, the other taxes.');
    expect(printed).toContain('Summary');
    logSpy.mockRestore();
  });

  it('records skip decisions', async () => {
    const propose = vi.fn().mockResolvedValue({
      narrative: 'n',
      proposedCode: 'c',
      confidence: 'low',
      confidenceReason: 'r',
    });
    const ask = vi.fn().mockResolvedValue('s');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const decisions = await runResolve({ cwd: repo, propose, ask, spinner: false });
    expect(decisions[0]?.choice).toBe('skip');
    logSpy.mockRestore();
  });
});
