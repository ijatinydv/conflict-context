import { describe, it, expect } from 'vitest';
import { applyHunkEdits, hasConflictMarkers } from '../../src/core/applier.js';

const content = [
  'line 1',
  '<<<<<<< HEAD',
  'ours A',
  '=======',
  'theirs A',
  '>>>>>>> f',
  'middle',
  '<<<<<<< HEAD',
  'ours B',
  '=======',
  'theirs B',
  '>>>>>>> f',
  'line last',
].join('\n');

describe('applyHunkEdits', () => {
  it('replaces a single hunk and preserves everything else', () => {
    const result = applyHunkEdits(content, [{ startLine: 2, endLine: 6, replacement: 'merged A' }]);
    expect(result.split('\n')).toEqual([
      'line 1',
      'merged A',
      'middle',
      '<<<<<<< HEAD',
      'ours B',
      '=======',
      'theirs B',
      '>>>>>>> f',
      'line last',
    ]);
  });

  it('applies multiple hunks regardless of input order', () => {
    const edits = [
      { startLine: 2, endLine: 6, replacement: 'merged A' },
      { startLine: 8, endLine: 12, replacement: 'merged B1\nmerged B2' },
    ];
    const forward = applyHunkEdits(content, edits);
    const backward = applyHunkEdits(content, [...edits].reverse());
    expect(forward).toBe(backward);
    expect(forward.split('\n')).toEqual([
      'line 1',
      'merged A',
      'middle',
      'merged B1',
      'merged B2',
      'line last',
    ]);
  });

  it('supports empty replacements (deleting the region)', () => {
    const result = applyHunkEdits(content, [{ startLine: 2, endLine: 6, replacement: '' }]);
    expect(result).toContain('line 1\nmiddle');
  });
});

describe('hasConflictMarkers', () => {
  it('is true while any marker remains and false when fully resolved', () => {
    expect(hasConflictMarkers(content)).toBe(true);
    const resolved = applyHunkEdits(content, [
      { startLine: 2, endLine: 6, replacement: 'a' },
      { startLine: 8, endLine: 12, replacement: 'b' },
    ]);
    expect(hasConflictMarkers(resolved)).toBe(false);
  });

  it('does not false-positive on heredoc-like content', () => {
    expect(hasConflictMarkers('const s = "<<<<<<< nope";')).toBe(false);
  });
});
