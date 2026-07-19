/**
 * Cheap, offline pre-classification of a conflict hunk, run before any LLM
 * call. Mechanical conflicts (formatting, import shuffling, renames) are easy
 * to detect textually, and the result both hints the resolution prompt and
 * floors the confidence so the model can't underrate a trivially-safe merge.
 */

import type { ConflictClass, ConflictHunk, Resolution } from '../types/index.js';


const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

/** Minimum confidence per class; logic conflicts get no floor. */
const CONFIDENCE_FLOOR: Partial<Record<ConflictClass, Resolution['confidence']>> = {
  'formatting-only': 'high',
  'import-ordering': 'high',
  'pure-rename': 'medium',
};

function stripCommentsAndWhitespace(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, '');
}

function isImportLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('import ') ||
    trimmed.startsWith('import{') ||
    /^(const|let|var)\s+.*=\s*require\(/.test(trimmed) ||
    // continuation lines of a multi-line import block
    /^[}\w$,{\s*]+from\s+['"].+['"];?$/.test(trimmed)
  );
}

function isImportOrdering(head: string[], incoming: string[]): boolean {
  const meaningful = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean);
  const h = meaningful(head);
  const i = meaningful(incoming);
  if (h.length === 0 || i.length === 0) return false;
  if (![...h, ...i].every(isImportLine)) return false;
  return [...h].sort().join('\n') === [...i].sort().join('\n');
}

const IDENTIFIER = /[A-Za-z_$][\w$]*|\d+|[^\sA-Za-z_$\d]/g;

/**
 * True when both sides are the same token stream except for a single
 * identifier consistently substituted (oldName -> newName everywhere).
 */
function isPureRename(head: string[], incoming: string[]): boolean {
  const headTokens = head.join('\n').match(IDENTIFIER) ?? [];
  const incomingTokens = incoming.join('\n').match(IDENTIFIER) ?? [];
  if (headTokens.length !== incomingTokens.length || headTokens.length === 0) return false;

  let from: string | undefined;
  let to: string | undefined;
  for (let i = 0; i < headTokens.length; i++) {
    const a = headTokens[i]!;
    const b = incomingTokens[i]!;
    if (a === b) continue;
    if (!/^[A-Za-z_$]/.test(a) || !/^[A-Za-z_$]/.test(b)) return false;
    if (from === undefined) {
      from = a;
      to = b;
    } else if (a !== from || b !== to) {
      return false;
    }
  }
  return from !== undefined;
}

export function classifyHunk(hunk: ConflictHunk): ConflictClass {
  const { headOriginLines: head, incomingLines: incoming } = hunk;

  if (stripCommentsAndWhitespace(head) === stripCommentsAndWhitespace(incoming)) {
    return 'formatting-only';
  }
  if (isImportOrdering(head, incoming)) return 'import-ordering';
  // Import hunks that differ in content (not just order) mean different
  // dependencies, which is never a "rename" even if tokens substitute cleanly.
  const allImports = [...head, ...incoming].map((l) => l.trim()).filter(Boolean).every(isImportLine);
  if (!allImports && isPureRename(head, incoming)) return 'pure-rename';
  return 'logic-conflict';
}

/** Raises resolution confidence to the class floor; never lowers it. */
export function applyConfidenceFloor(
  resolution: Resolution,
  classification: ConflictClass,
): Resolution {
  const floor = CONFIDENCE_FLOOR[classification];
  if (!floor || CONFIDENCE_RANK[resolution.confidence] >= CONFIDENCE_RANK[floor]) {
    return resolution;
  }
  return {
    ...resolution,
    confidence: floor,
    confidenceReason: `${resolution.confidenceReason} (raised to ${floor}: heuristically detected ${classification})`,
  };
}
