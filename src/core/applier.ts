/**
 * Pure application of accepted resolutions: replaces marker-delimited line
 * ranges with proposed code. No filesystem access — callers hand in content
 * and write the result — so multi-hunk edge cases are unit-testable.
 */

export interface HunkEdit {
  /** 1-based inclusive range of the conflict, `<<<<<<<` through `>>>>>>>`. */
  startLine: number;
  endLine: number;
  replacement: string;
}

/**
 * Applies edits to `content`. Edits are processed bottom-up so earlier
 * replacements can't shift the line numbers of later ones; the input order
 * doesn't matter. Ranges must not overlap.
 */
export function applyHunkEdits(content: string, edits: HunkEdit[]): string {
  const lines = content.split('\n');
  const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);

  for (const edit of sorted) {
    const replacementLines = edit.replacement === '' ? [] : edit.replacement.split('\n');
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines);
  }
  return lines.join('\n');
}

const MARKER = /^(<{7}|>{7})(\s|$)/m;

/** True while any conflict marker remains — the file isn't fully resolved. */
export function hasConflictMarkers(content: string): boolean {
  return MARKER.test(content);
}
