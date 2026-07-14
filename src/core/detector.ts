/**
 * Pure parser for git conflict markers. String in, structured data out — no
 * filesystem or git calls — so it is trivially unit-testable. Handles both
 * diff2 and diff3 (with the `|||||||` common-ancestor section) marker styles
 * and multiple hunks per file.
 */

import type { ConflictHunk } from '../types/index.js';

export class ConflictParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictParseError';
  }
}

const HEAD = /^<{7}(\s|$)/;
const BASE = /^\|{7}(\s|$)/;
const SEP = /^={7}(\s|$)/;
const INCOMING = /^>{7}(\s|$)/;

type Section = 'head' | 'base' | 'incoming';

export function parseConflicts(content: string): ConflictHunk[] {
  const lines = content.split('\n');
  const hunks: ConflictHunk[] = [];

  let inConflict = false;
  let section: Section = 'head';
  let startLine = 0;
  let headOriginLines: string[] = [];
  let baseLines: string[] = [];
  let incomingLines: string[] = [];

  const fail = (lineNo: number, msg: string): never => {
    throw new ConflictParseError(`Malformed conflict marker at line ${lineNo}: ${msg}`);
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    if (HEAD.test(line)) {
      if (inConflict) fail(lineNo, 'nested "<<<<<<<" before the previous hunk closed');
      inConflict = true;
      section = 'head';
      startLine = lineNo;
      headOriginLines = [];
      baseLines = [];
      incomingLines = [];
      return;
    }

    if (!inConflict) return;

    if (BASE.test(line)) {
      if (section !== 'head') fail(lineNo, 'unexpected "|||||||" common-ancestor marker');
      section = 'base';
      return;
    }

    if (SEP.test(line)) {
      if (section === 'incoming') fail(lineNo, 'duplicate "=======" separator');
      section = 'incoming';
      return;
    }

    if (INCOMING.test(line)) {
      if (section !== 'incoming') fail(lineNo, '">>>>>>>" before a "=======" separator');
      hunks.push({
        headOriginLines,
        incomingLines,
        ...(baseLines.length > 0 ? { baseLines } : {}),
        startLine,
        endLine: lineNo,
      });
      inConflict = false;
      return;
    }

    if (section === 'head') headOriginLines.push(line);
    else if (section === 'base') baseLines.push(line);
    else incomingLines.push(line);
  });

  if (inConflict) {
    throw new ConflictParseError(
      `Unterminated conflict starting at line ${startLine}: missing ">>>>>>>" marker`,
    );
  }

  return hunks;
}
