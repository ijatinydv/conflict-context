import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPatternStore,
  savePattern,
  findMatchingPattern,
  incrementUseCount,
} from '../../src/core/patternStore.js';
import type { ConflictHunk, EnclosingContext, Resolution } from '../../src/types/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const hunk: ConflictHunk = {
  headOriginLines: ['  return input.trim();'],
  incomingLines: ['  return input.trim().toLowerCase();'],
  startLine: 3,
  endLine: 7,
};

const astContext: EnclosingContext = {
  nodeType: 'function_declaration',
  startLine: 1,
  endLine: 10,
  code: 'function parse(input) { return input.trim(); }',
};

const resolution: Resolution = {
  narrative: 'HEAD trims; incoming also lowercases. Both intents can be kept.',
  proposedCode: '  return input.trim().toLowerCase();',
  confidence: 'high',
  confidenceReason: 'Changes are independent and compose cleanly.',
};

// ── Repo fixture ──────────────────────────────────────────────────────────────

describe('patternStore', () => {
  let repo: string;

  const git = (args: string[]) => execa('git', args, { cwd: repo });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cc-pstore-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@test.local']);
    await git(['config', 'user.name', 'Test Author']);
    await git(['config', 'commit.gpgsign', 'false']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // ── loadPatternStore ────────────────────────────────────────────────────────

  it('returns an empty store when no file exists yet', async () => {
    const store = await loadPatternStore(repo);
    expect(store.version).toBe(1);
    expect(store.patterns).toHaveLength(0);
  });

  // ── savePattern + round-trip ────────────────────────────────────────────────

  it('saves a pattern and reads it back', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    const store = await loadPatternStore(repo);

    expect(store.patterns).toHaveLength(1);
    const p = store.patterns[0]!;
    expect(p.filePath).toBe('src/utils/parse.ts');
    expect(p.nodeType).toBe('function_declaration');
    expect(p.conflictClass).toBe('logic-conflict');
    expect(p.resolvedCode).toBe(resolution.proposedCode);
    expect(p.narrative).toBe(resolution.narrative);
    expect(p.confidence).toBe('high');
    expect(p.acceptedBy).toBe('Test Author');
    expect(p.useCount).toBe(0);
    expect(p.id).toHaveLength(12);
  });

  it('the pattern id is deterministic for the same input', async () => {
    const a = await savePattern('f.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    // Wipe and re-save to check we get the same id from a fresh store.
    await rm(join(repo, '.cctx'), { recursive: true, force: true });
    const b = await savePattern('f.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    expect(a.id).toBe(b.id);
  });

  it('updates an existing entry rather than duplicating on re-accept', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);

    // Simulate the pattern being used once so useCount > 0.
    const store = await loadPatternStore(repo);
    store.patterns[0]!.useCount = 3;
    const { savePatternStore } = await import('../../src/core/patternStore.js');
    await savePatternStore(store, repo);

    // Re-accept the same conflict with a different proposed code.
    const updated: Resolution = { ...resolution, proposedCode: '  return input.toLowerCase().trim();' };
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', updated, repo);

    const after = await loadPatternStore(repo);
    expect(after.patterns).toHaveLength(1);
    expect(after.patterns[0]!.resolvedCode).toBe('  return input.toLowerCase().trim();');
    // useCount must be preserved — not reset to 0.
    expect(after.patterns[0]!.useCount).toBe(3);
  });

  it('persists to .cctx/patterns.json in the repo root', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    const raw = await readFile(join(repo, '.cctx', 'patterns.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  // ── findMatchingPattern ────────────────────────────────────────────────────

  it('returns undefined for an empty store', async () => {
    const match = await findMatchingPattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', repo);
    expect(match).toBeUndefined();
  });

  it('finds a matching pattern for an identical hunk', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    const match = await findMatchingPattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', repo);
    expect(match).toBeDefined();
    expect(match!.pattern.resolvedCode).toBe(resolution.proposedCode);
  });

  it('returns undefined for a different file path', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    const match = await findMatchingPattern('src/other/parse.ts', hunk, astContext, 'logic-conflict', repo);
    expect(match).toBeUndefined();
  });

  it('returns undefined for a different conflict class', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    const match = await findMatchingPattern('src/utils/parse.ts', hunk, astContext, 'formatting-only', repo);
    expect(match).toBeUndefined();
  });

  it('returns undefined when head lines differ', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    const differentHunk: ConflictHunk = { ...hunk, headOriginLines: ['  return input;'] };
    const match = await findMatchingPattern('src/utils/parse.ts', differentHunk, astContext, 'logic-conflict', repo);
    expect(match).toBeUndefined();
  });

  // ── incrementUseCount ─────────────────────────────────────────────────────

  it('increments the useCount of a matched pattern', async () => {
    const saved = await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    await incrementUseCount(saved.id, repo);
    const store = await loadPatternStore(repo);
    expect(store.patterns[0]!.useCount).toBe(1);
  });

  it('is a no-op when the id is not found', async () => {
    await savePattern('src/utils/parse.ts', hunk, astContext, 'logic-conflict', resolution, repo);
    await incrementUseCount('nonexistent000', repo);
    const store = await loadPatternStore(repo);
    expect(store.patterns[0]!.useCount).toBe(0);
  });
});
