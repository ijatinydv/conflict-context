/**
 * Persistent pattern store for the conflict-context pattern memory feature.
 * Patterns are saved to .cctx/patterns.json in the repo root (relative to cwd)
 * so they can be committed and shared with the team.
 *
 * Design decisions:
 * - .cctx/ in repo root (not .git/) so `git add .cctx/patterns.json` just works
 *   and teammates who clone the repo immediately benefit from learned patterns.
 * - Atomic: we always read → mutate → write the full store; no partial updates.
 * - ID is deterministic (sha256 of path|nodeType|class|headFp|incomingFp) so
 *   the same logical conflict always maps to the same record and re-accepting
 *   updates the existing entry rather than creating a duplicate.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getGitUserName } from '../git/gitClient.js';
import { fingerprintLines, buildCandidate, isMatch } from './patternMatcher.js';
import type {
  ConflictClass,
  ConflictHunk,
  EnclosingContext,
  Pattern,
  PatternMatch,
  PatternStore,
  Resolution,
} from '../types/index.js';

const STORE_DIR = '.cctx';
const STORE_FILE = 'patterns.json';

function storePath(cwd: string): string {
  return join(cwd, STORE_DIR, STORE_FILE);
}

export async function loadPatternStore(cwd: string = process.cwd()): Promise<PatternStore> {
  try {
    const raw = await readFile(storePath(cwd), 'utf8');
    return JSON.parse(raw) as PatternStore;
  } catch {
    // Missing file is the normal case on first use — return an empty store.
    return { version: 1, patterns: [] };
  }
}

export async function savePatternStore(
  store: PatternStore,
  cwd: string = process.cwd(),
): Promise<void> {
  await mkdir(join(cwd, STORE_DIR), { recursive: true });
  await writeFile(storePath(cwd), JSON.stringify(store, null, 2));
}

function generateId(
  filePath: string,
  nodeType: string,
  conflictClass: ConflictClass,
  headFp: string,
  incomingFp: string,
): string {
  return createHash('sha256')
    .update(`${filePath}|${nodeType}|${conflictClass}|${headFp}|${incomingFp}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Persists an accepted resolution as a pattern. If a pattern with the same id
 * already exists (same conflict recurring), it is updated in place and its
 * `useCount` is preserved; otherwise a new entry is appended.
 */
export async function savePattern(
  filePath: string,
  hunk: ConflictHunk,
  astContext: EnclosingContext,
  conflictClass: ConflictClass,
  resolution: Resolution,
  cwd: string = process.cwd(),
): Promise<Pattern> {
  const store = await loadPatternStore(cwd);
  const headFp = fingerprintLines(hunk.headOriginLines);
  const incomingFp = fingerprintLines(hunk.incomingLines);
  const id = generateId(filePath, astContext.nodeType, conflictClass, headFp, incomingFp);

  const existingIdx = store.patterns.findIndex((p) => p.id === id);
  const acceptedBy = await getGitUserName(cwd);

  const pattern: Pattern = {
    id,
    filePath,
    nodeType: astContext.nodeType,
    conflictClass,
    headFingerprint: headFp,
    incomingFingerprint: incomingFp,
    resolvedCode: resolution.proposedCode,
    narrative: resolution.narrative,
    confidence: resolution.confidence,
    acceptedAt: new Date().toISOString(),
    acceptedBy,
    // Re-accepting a pattern keeps its accumulated useCount.
    useCount: existingIdx >= 0 ? (store.patterns[existingIdx]!.useCount) : 0,
  };

  if (existingIdx >= 0) {
    store.patterns[existingIdx] = pattern;
  } else {
    store.patterns.push(pattern);
  }

  await savePatternStore(store, cwd);
  return pattern;
}

/**
 * Returns the first pattern that matches the live hunk, or undefined when
 * none is found. Matching uses the four-criteria rule from patternMatcher.ts.
 */
export async function findMatchingPattern(
  filePath: string,
  hunk: ConflictHunk,
  astContext: EnclosingContext,
  conflictClass: ConflictClass,
  cwd: string = process.cwd(),
): Promise<PatternMatch | undefined> {
  const store = await loadPatternStore(cwd);
  if (store.patterns.length === 0) return undefined;

  const candidate = buildCandidate(filePath, hunk, astContext, conflictClass);
  const matched = store.patterns.find((p) => isMatch(p, candidate));
  return matched ? { pattern: matched } : undefined;
}

/**
 * Increments the useCount of a pattern after it is applied without an LLM call.
 * A no-op when the id is no longer in the store.
 */
export async function incrementUseCount(
  patternId: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const store = await loadPatternStore(cwd);
  const pattern = store.patterns.find((p) => p.id === patternId);
  if (!pattern) return;
  pattern.useCount += 1;
  await savePatternStore(store, cwd);
}
