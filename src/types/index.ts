/**
 * Shared interfaces describing the data that flows between the git wrapper,
 * conflict detector, history extractor, LLM layer, and CLI. Logic-free by
 * design — error classes stay with the modules that throw them.
 */

import type Anthropic from '@anthropic-ai/sdk';

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  // Full message: subject line plus body.
  message: string;
  subject: string;
  // Patch snippet scoped to the file of interest; set only by `git log -p`.
  diff?: string;
}

/**
 * One conflict region within a file. Line numbers are 1-based and index the
 * raw, marker-laden content: `startLine` is the `<<<<<<<` line and `endLine`
 * the `>>>>>>>` line, both inclusive.
 */
export interface ConflictHunk {
  headOriginLines: string[];
  incomingLines: string[];
  /** Common-ancestor section, present only for diff3-style markers. */
  baseLines?: string[];
  startLine: number;
  endLine: number;
}

export interface ConflictedFile {
  path: string;
  /** Raw working-tree content, still including conflict markers. */
  content: string;
  hunks: ConflictHunk[];
}

export interface Conflict {
  operation: 'merge' | 'rebase';
  files: ConflictedFile[];
}

/** Commit history behind each side of a single conflict hunk. */
export interface HunkContext {
  headCommits: CommitInfo[];
  incomingCommits: CommitInfo[];
}

/** LLM-proposed merge for one hunk, parsed from a strict-JSON response. */
export interface Resolution {
  narrative: string;
  proposedCode: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceReason: string;
}

/** A decided replacement for one conflict region, ready to splice into a file. */
export interface HunkEdit {
  /** 1-based inclusive range of the conflict, `<<<<<<<` through `>>>>>>>`. */
  startLine: number;
  endLine: number;
  replacement: string;
}

/** One line's authorship as reported by `git blame --line-porcelain`. */
export interface BlameLine {
  lineNumber: number;
  hash: string;
  author: string;
}

/** Smallest AST declaration (or raw-line fallback) enclosing a conflict. */
export interface EnclosingContext {
  /** AST node type, or 'fallback' when parsing was not possible. */
  nodeType: string;
  startLine: number;
  endLine: number;
  code: string;
}

/** Heuristic, offline classification of a hunk — computed before any LLM call. */
export type ConflictClass =
  | 'formatting-only'
  | 'import-ordering'
  | 'pure-rename'
  | 'logic-conflict';

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'bluesminds';

/** Minimal surface of the Anthropic client the LLM layer depends on. */
export interface NarrativeClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

// ── CLI orchestrator contracts ──────────────────────────────────────────────

export type NarrateFn = (hunk: ConflictHunk, context: HunkContext) => Promise<string>;

export interface ExplainOptions {
  cwd?: string;
  file?: string;
  narrate?: NarrateFn;
  /** Suppresses the ora spinner during tests. */
  spinner?: boolean;
}

export type Choice = 'accept' | 'edit' | 'skip' | 'auto';

export type ProposeFn = (
  hunk: ConflictHunk,
  context: HunkContext,
  astContext: EnclosingContext,
  classificationHint?: string,
) => Promise<Resolution>;

/** Asks the user for a choice; injectable so tests can script answers. */
export type AskFn = (question: string) => Promise<string>;

/** Lets the user rework proposed code; injectable so tests avoid $EDITOR. */
export type EditFn = (proposedCode: string) => Promise<string>;

export interface ResolveOptions {
  cwd?: string;
  file?: string;
  propose?: ProposeFn;
  ask?: AskFn;
  edit?: EditFn;
  spinner?: boolean;
  /** Apply hunks at or above minConfidence without prompting. */
  auto?: boolean;
  minConfidence?: Resolution['confidence'];
  /** Show what would happen without writing files, staging, or snapshotting. */
  dryRun?: boolean;
}

export interface HunkDecision {
  file: string;
  startLine: number;
  endLine: number;
  choice: Choice;
  confidence: Resolution['confidence'];
  applied: boolean;
}
