import { describe, it, expect } from 'vitest';
import { fingerprintLines, isMatch, buildCandidate } from '../../src/core/patternMatcher.js';
import type { ConflictHunk, EnclosingContext, Pattern } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const makePattern = (overrides: Partial<Pattern> = {}): Pattern => ({
  id: 'abc123def456',
  filePath: 'src/utils/parse.ts',
  nodeType: 'function_declaration',
  conflictClass: 'logic-conflict',
  headFingerprint: fingerprintLines(['  return input.trim();']),
  incomingFingerprint: fingerprintLines(['  return input.trim().toLowerCase();']),
  resolvedCode: '  return input.trim().toLowerCase();',
  narrative: 'HEAD guards against null; incoming normalises case.',
  confidence: 'high',
  acceptedAt: '2026-01-01T00:00:00.000Z',
  acceptedBy: 'dev',
  useCount: 0,
  ...overrides,
});

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

// ── fingerprintLines ──────────────────────────────────────────────────────────

describe('fingerprintLines', () => {
  it('returns a 16-char hex string', () => {
    const fp = fingerprintLines(['hello world']);
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it('is stable for the same content', () => {
    const a = fingerprintLines(['  return x;']);
    const b = fingerprintLines(['  return x;']);
    expect(a).toBe(b);
  });

  it('normalises whitespace differences to the same fingerprint', () => {
    const a = fingerprintLines(['return   x;']);
    const b = fingerprintLines(['return x;']);
    expect(a).toBe(b);
  });

  it('strips line comments before hashing', () => {
    const a = fingerprintLines(['return x; // unused']);
    const b = fingerprintLines(['return x;']);
    expect(a).toBe(b);
  });

  it('strips block comments before hashing', () => {
    const a = fingerprintLines(['/* old */ return x;']);
    const b = fingerprintLines(['return x;']);
    expect(a).toBe(b);
  });

  it('produces different fingerprints for different code', () => {
    const a = fingerprintLines(['return x;']);
    const b = fingerprintLines(['return y;']);
    expect(a).not.toBe(b);
  });

  it('handles an empty array', () => {
    expect(fingerprintLines([])).toHaveLength(16);
  });
});

// ── isMatch ───────────────────────────────────────────────────────────────────

describe('isMatch', () => {
  it('matches when all four criteria hold', () => {
    const pattern = makePattern();
    const candidate = buildCandidate('src/utils/parse.ts', hunk, astContext, 'logic-conflict');
    expect(isMatch(pattern, candidate)).toBe(true);
  });

  it('does not match a different file path', () => {
    const pattern = makePattern();
    const candidate = buildCandidate('src/other/parse.ts', hunk, astContext, 'logic-conflict');
    expect(isMatch(pattern, candidate)).toBe(false);
  });

  it('does not match a different AST node type', () => {
    const pattern = makePattern({ nodeType: 'arrow_function' });
    const candidate = buildCandidate('src/utils/parse.ts', hunk, astContext, 'logic-conflict');
    expect(isMatch(pattern, candidate)).toBe(false);
  });

  it('does not match a different conflict class', () => {
    const pattern = makePattern({ conflictClass: 'formatting-only' });
    const candidate = buildCandidate('src/utils/parse.ts', hunk, astContext, 'logic-conflict');
    expect(isMatch(pattern, candidate)).toBe(false);
  });

  it('does not match when only head fingerprint differs', () => {
    const pattern = makePattern({ headFingerprint: 'deadbeefcafe0000' });
    const candidate = buildCandidate('src/utils/parse.ts', hunk, astContext, 'logic-conflict');
    expect(isMatch(pattern, candidate)).toBe(false);
  });

  it('does not match when only incoming fingerprint differs', () => {
    const pattern = makePattern({ incomingFingerprint: 'deadbeefcafe0001' });
    const candidate = buildCandidate('src/utils/parse.ts', hunk, astContext, 'logic-conflict');
    expect(isMatch(pattern, candidate)).toBe(false);
  });
});

// ── buildCandidate ────────────────────────────────────────────────────────────

describe('buildCandidate', () => {
  it('encodes file path, node type, conflict class, and fingerprints', () => {
    const candidate = buildCandidate('src/utils/parse.ts', hunk, astContext, 'logic-conflict');
    expect(candidate.filePath).toBe('src/utils/parse.ts');
    expect(candidate.nodeType).toBe('function_declaration');
    expect(candidate.conflictClass).toBe('logic-conflict');
    expect(candidate.headFingerprint).toHaveLength(16);
    expect(candidate.incomingFingerprint).toHaveLength(16);
    // head and incoming are genuinely different code — fingerprints must differ
    expect(candidate.headFingerprint).not.toBe(candidate.incomingFingerprint);
  });
});
