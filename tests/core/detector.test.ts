import { describe, it, expect } from 'vitest';
import { parseConflicts, ConflictParseError } from '../../src/core/detector.js';

const marker = (s: string) => s; // readability helper for building fixtures

describe('parseConflicts', () => {
  it('returns an empty array when there are no conflicts', () => {
    expect(parseConflicts('const a = 1;\nconst b = 2;\n')).toEqual([]);
  });

  it('parses a single diff2 hunk with correct line numbers', () => {
    const content = [
      'line 1',
      '<<<<<<< HEAD',
      'ours a',
      'ours b',
      '=======',
      'theirs a',
      '>>>>>>> feature',
      'line 8',
    ].join('\n');

    const hunks = parseConflicts(content);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      headOriginLines: ['ours a', 'ours b'],
      incomingLines: ['theirs a'],
      startLine: 2,
      endLine: 7,
    });
    expect(hunks[0]?.baseLines).toBeUndefined();
  });

  it('parses multiple hunks in one file', () => {
    const content = [
      '<<<<<<< HEAD',
      'ours 1',
      '=======',
      'theirs 1',
      '>>>>>>> b',
      'middle',
      '<<<<<<< HEAD',
      'ours 2',
      '=======',
      'theirs 2',
      '>>>>>>> b',
    ].join('\n');

    const hunks = parseConflicts(content);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.headOriginLines).toEqual(['ours 1']);
    expect(hunks[1]?.incomingLines).toEqual(['theirs 2']);
    expect(hunks[1]?.startLine).toBe(7);
  });

  it('parses diff3 style capturing the common-ancestor section', () => {
    const content = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| merged common ancestors',
      'base',
      '=======',
      'theirs',
      '>>>>>>> feature',
    ].join('\n');

    const hunks = parseConflicts(content);
    expect(hunks[0]?.baseLines).toEqual(['base']);
    expect(hunks[0]?.headOriginLines).toEqual(['ours']);
    expect(hunks[0]?.incomingLines).toEqual(['theirs']);
  });

  it('throws on an unterminated conflict', () => {
    const content = [marker('<<<<<<< HEAD'), 'ours', '=======', 'theirs'].join('\n');
    expect(() => parseConflicts(content)).toThrow(ConflictParseError);
  });

  it('throws on a stray incoming marker without a separator', () => {
    const content = ['<<<<<<< HEAD', 'ours', '>>>>>>> feature'].join('\n');
    expect(() => parseConflicts(content)).toThrow(ConflictParseError);
  });
});
