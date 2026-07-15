import { describe, it, expect } from 'vitest';
import { classifyHunk, applyConfidenceFloor } from '../../src/core/confidence.js';
import type { ConflictHunk, Resolution } from '../../src/types/index.js';

const hunk = (head: string[], incoming: string[]): ConflictHunk => ({
  headOriginLines: head,
  incomingLines: incoming,
  startLine: 1,
  endLine: head.length + incoming.length + 3,
});

describe('classifyHunk', () => {
  it('detects formatting-only conflicts (whitespace and comments)', () => {
    const result = classifyHunk(
      hunk(
        ['function add(a, b) { return a + b; }'],
        ['function add(a, b) {', '  // sum the operands', '  return a + b;', '}'],
      ),
    );
    expect(result).toBe('formatting-only');
  });

  it('detects import-ordering conflicts', () => {
    const result = classifyHunk(
      hunk(
        ["import { a } from './a';", "import { b } from './b';"],
        ["import { b } from './b';", "import { a } from './a';"],
      ),
    );
    expect(result).toBe('import-ordering');
  });

  it('does not call differing import sets import-ordering', () => {
    const result = classifyHunk(
      hunk(["import { a } from './a';"], ["import { c } from './c';"]),
    );
    expect(result).toBe('logic-conflict');
  });

  it('detects a pure rename applied consistently', () => {
    const result = classifyHunk(
      hunk(
        ['const total = price * qty;', 'return total;'],
        ['const sum = price * qty;', 'return sum;'],
      ),
    );
    expect(result).toBe('pure-rename');
  });

  it('treats an inconsistent rename as a logic conflict', () => {
    const result = classifyHunk(
      hunk(
        ['const total = price * qty;', 'return total;'],
        ['const sum = price * qty;', 'return sumX;'],
      ),
    );
    expect(result).toBe('logic-conflict');
  });

  it('classifies genuinely different logic as logic-conflict', () => {
    const result = classifyHunk(
      hunk(['if (user == null) return "";'], ['return user.name.toLowerCase();']),
    );
    expect(result).toBe('logic-conflict');
  });
});

describe('applyConfidenceFloor', () => {
  const resolution: Resolution = {
    narrative: 'n',
    proposedCode: 'c',
    confidence: 'low',
    confidenceReason: 'model was unsure',
  };

  it('raises formatting-only conflicts to high', () => {
    const result = applyConfidenceFloor(resolution, 'formatting-only');
    expect(result.confidence).toBe('high');
    expect(result.confidenceReason).toContain('formatting-only');
  });

  it('never lowers an already-high confidence', () => {
    const high = { ...resolution, confidence: 'high' as const };
    expect(applyConfidenceFloor(high, 'pure-rename').confidence).toBe('high');
  });

  it('lets the model rate logic conflicts freely', () => {
    expect(applyConfidenceFloor(resolution, 'logic-conflict').confidence).toBe('low');
  });
});
