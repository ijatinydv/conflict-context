/**
 * Shared interfaces describing the data that flows between the git wrapper,
 * conflict detector, history extractor, and LLM layer. Logic-free by design.
 */

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
