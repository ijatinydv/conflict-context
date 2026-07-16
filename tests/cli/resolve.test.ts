import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResolve } from '../../src/cli/resolve.js';
import { hasSnapshot } from '../../src/git/snapshot.js';
import type { Resolution } from '../../src/types/index.js';

const resolution = (code: string): Resolution => ({
  narrative: 'mock narrative',
  proposedCode: code,
  confidence: 'medium',
  confidenceReason: 'mock',
});

describe('runResolve', () => {
  let repo: string;
  const file = 'calc.js';

  const git = (args: string[]) => execa('git', args, { cwd: repo });
  const silenceLogs = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-resolve-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@test.local']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'commit.gpgsign', 'false']);

    // Two independently-edited regions => two conflict hunks in one file.
    const base = ['function a() {', '  return 1;', '}', '', '// spacer 1', '// spacer 2', '// spacer 3', '', 'function b() {', '  return 2;', '}'];
    await writeFile(join(repo, file), base.join('\n'));
    await git(['add', file]);
    await git(['commit', '-m', 'base']);

    await git(['checkout', '-b', 'feature']);
    await writeFile(
      join(repo, file),
      ['function a() {', '  return 10;', '}', '', '// spacer 1', '// spacer 2', '// spacer 3', '', 'function b() {', '  return 20;', '}'].join('\n'),
    );
    await git(['commit', '-am', 'feature: tens']);

    await git(['checkout', 'main']);
    await writeFile(
      join(repo, file),
      ['function a() {', '  return 100;', '}', '', '// spacer 1', '// spacer 2', '// spacer 3', '', 'function b() {', '  return 200;', '}'].join('\n'),
    );
    await git(['commit', '-am', 'main: hundreds']);
    await git(['merge', 'feature']).catch(() => undefined);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('applies accepted hunks, stages fully-resolved files, and snapshots first', async () => {
    const propose = vi.fn().mockResolvedValue(resolution('  return 42;'));
    const ask = vi.fn().mockResolvedValue('a');
    const logSpy = silenceLogs();

    const decisions = await runResolve({ cwd: repo, propose, ask, spinner: false });

    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.applied)).toBe(true);
    expect(await hasSnapshot(repo)).toBe(true);

    const content = await readFile(join(repo, file), 'utf8');
    expect(content).not.toContain('<<<<<<<');
    expect(content.match(/return 42;/g)).toHaveLength(2);
    // fully resolved => staged, no unmerged entries left
    expect((await git(['ls-files', '-u'])).stdout).toBe('');
    logSpy.mockRestore();
  });

  it('leaves markers and staging intact for skipped hunks (partial acceptance)', async () => {
    const propose = vi.fn().mockResolvedValue(resolution('  return 42;'));
    const ask = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('s');
    const logSpy = silenceLogs();

    const decisions = await runResolve({ cwd: repo, propose, ask, spinner: false });

    expect(decisions.map((d) => d.choice)).toEqual(['accept', 'skip']);
    const content = await readFile(join(repo, file), 'utf8');
    expect(content).toContain('return 42;');
    expect(content).toContain('<<<<<<<'); // second hunk untouched
    expect((await git(['ls-files', '-u'])).stdout).not.toBe(''); // still unmerged
    logSpy.mockRestore();
  });

  it('routes edit choices through the editor function before applying', async () => {
    const propose = vi.fn().mockResolvedValue(resolution('  return 42;'));
    const ask = vi.fn().mockResolvedValueOnce('e').mockResolvedValueOnce('s');
    const edit = vi.fn().mockResolvedValue('  return 777; // hand-edited');
    const logSpy = silenceLogs();

    await runResolve({ cwd: repo, propose, ask, edit, spinner: false });

    expect(edit).toHaveBeenCalledWith('  return 42;');
    const content = await readFile(join(repo, file), 'utf8');
    expect(content).toContain('return 777; // hand-edited');
    logSpy.mockRestore();
  });
});
