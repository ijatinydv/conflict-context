import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStats } from '../../src/cli/stats.js';
import { savePattern } from '../../src/core/patternStore.js';
import { incrementUseCount } from '../../src/core/patternStore.js';

describe('runStats', () => {
  let repo: string;
  let logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((msg?: any, ...optionalParams: any[]) => {
    logs.push([msg, ...optionalParams].join(' '));
  });

  const git = (args: string[]) => execa('git', args, { cwd: repo });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-stats-'));
    logs = [];
    
    // minimal git setup
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@test.local']);
    await git(['config', 'user.name', 'Test']);
  });

  afterEach(async () => {
    logSpy.mockClear();
    await rm(repo, { recursive: true, force: true });
  });

  it('handles an empty pattern store', async () => {
    await runStats({ cwd: repo });
    
    expect(logs.some(l => l.includes('No patterns learned yet'))).toBe(true);
  });

  it('prints aggregate metrics for populated store', async () => {
    const hunk = {
      headOriginLines: ['a'],
      incomingLines: ['b'],
      startLine: 1,
      endLine: 5,
    };
    const ast = {
      nodeType: 'function_declaration',
      startLine: 1,
      endLine: 5,
      code: 'code',
    };
    const res = {
      narrative: 'test',
      proposedCode: 'c',
      confidence: 'high' as const,
      confidenceReason: 'test',
    };

    const p1 = await savePattern('src/a.ts', hunk, ast, 'logic-conflict', res, repo);
    await incrementUseCount(p1.id, repo);
    await incrementUseCount(p1.id, repo);
    
    await savePattern('src/a.ts', { ...hunk, headOriginLines: ['x'] }, ast, 'logic-conflict', res, repo);
    const p3 = await savePattern('src/b.ts', hunk, ast, 'formatting-only', res, repo);
    await incrementUseCount(p3.id, repo);

    logs = [];
    await runStats({ cwd: repo });

    const out = logs.join('\n');
    expect(out).toContain('Patterns learned:  3');
    expect(out).toContain('LLM calls saved:   3'); // 2 + 0 + 1
    expect(out).toContain('Top files');
    expect(out).toContain('2    src/a.ts');
    expect(out).toContain('1    src/b.ts');
  });
});
