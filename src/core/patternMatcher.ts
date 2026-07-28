/**
 * Offline fingerprinting and similarity scoring for conflict hunks, used by
 * the pattern store to match live hunks against previously learned resolutions.
 *
 * Fingerprinting: sha256 of the comment-stripped, whitespace-collapsed line
 * content, first 16 hex chars. Two hunks that are identical modulo
 * whitespace / comments therefore share the same fingerprint — a deliberate
 * normalisation so trivial reformats don't break learned patterns.
 *
 * Matching rule: a stored pattern is a candidate for a live hunk when all
 * four of these hold:
 *   1. Same file path (relative to repo root).
 *   2. Same AST node type (e.g. function_declaration, class_declaration).
 *   3. Same offline conflict class (formatting-only / import-ordering / …).
 *   4. Exact fingerprint match on both head and incoming sides.
 *
 * The exact-fingerprint gate means the store never proposes a pattern whose
 * origin conflict had a genuinely different code token stream — fuzzy matching
 * is deferred to a future version where the raw lines are also persisted.
 */

import { createHash } from 'node:crypto';
import type { ConflictClass, ConflictHunk, EnclosingContext, Pattern } from '../types/index.js';

/** Input bundle for pattern matching — built once per hunk before the store is queried. */
export interface MatchCandidate {
  filePath: string;
  nodeType: string;
  conflictClass: ConflictClass;
  headFingerprint: string;
  incomingFingerprint: string;
}

/**
 * Normalise `lines` (strip block/line comments, collapse whitespace) then
 * return the first 16 hex characters of the sha256 digest. Callers pass the
 * same normalisation through every code path so fingerprints are stable across
 * editors and formatters.
 */
export function fingerprintLines(lines: string[]): string {
  const normalised = lines
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/**
 * True when `pattern` is a strong-enough match for `candidate`.
 * All four criteria must hold (see module docblock for rationale).
 */
export function isMatch(pattern: Pattern, candidate: MatchCandidate): boolean {
  return (
    pattern.filePath === candidate.filePath &&
    pattern.nodeType === candidate.nodeType &&
    pattern.conflictClass === candidate.conflictClass &&
    pattern.headFingerprint === candidate.headFingerprint &&
    pattern.incomingFingerprint === candidate.incomingFingerprint
  );
}

/** Build a {@link MatchCandidate} from a live hunk + its resolved context. */
export function buildCandidate(
  filePath: string,
  hunk: ConflictHunk,
  astContext: EnclosingContext,
  conflictClass: ConflictClass,
): MatchCandidate {
  return {
    filePath,
    nodeType: astContext.nodeType,
    conflictClass,
    headFingerprint: fingerprintLines(hunk.headOriginLines),
    incomingFingerprint: fingerprintLines(hunk.incomingLines),
  };
}
