/**
 * AST-aware context extraction. Given a conflict's line range, finds the
 * smallest enclosing function/method/class so the LLM sees a meaningful unit
 * of code instead of arbitrary surrounding lines.
 *
 * Parsing is best-effort: tree-sitter is error-tolerant (conflict markers just
 * become error nodes), and any unsupported language or load failure falls back
 * to the raw line range plus a few lines of context — a bad parse must never
 * kill the whole run.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import Parser from 'web-tree-sitter';
import { log } from '../utils/logger.js';

type Language = Parser.Language;
type Node = Parser.SyntaxNode;

export interface EnclosingContext {
  /** AST node type, or 'fallback' when parsing was not possible. */
  nodeType: string;
  startLine: number;
  endLine: number;
  code: string;
}

const require = createRequire(import.meta.url);

const ENCLOSING_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'arrow_function',
  'method_definition',
  'class_declaration',
  'abstract_class_declaration',
]);

const FALLBACK_CONTEXT_LINES = 5;

let tsLanguage: Language | undefined;
let tsxLanguage: Language | undefined;

async function loadLanguage(ext: string): Promise<Language | undefined> {
  const grammarDir = dirname(require.resolve('tree-sitter-typescript/package.json'));
  await Parser.init();
  // The TypeScript grammar parses plain JS fine; TSX handles JSX syntax.
  if (ext === '.tsx' || ext === '.jsx') {
    tsxLanguage ??= await Parser.Language.load(join(grammarDir, 'tree-sitter-tsx.wasm'));
    return tsxLanguage;
  }
  if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.mts') {
    tsLanguage ??= await Parser.Language.load(join(grammarDir, 'tree-sitter-typescript.wasm'));
    return tsLanguage;
  }
  return undefined;
}

function fallbackContext(content: string, startLine: number, endLine: number): EnclosingContext {
  const lines = content.split('\n');
  const from = Math.max(1, startLine - FALLBACK_CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + FALLBACK_CONTEXT_LINES);
  return {
    nodeType: 'fallback',
    startLine: from,
    endLine: to,
    code: lines.slice(from - 1, to).join('\n'),
  };
}

/**
 * Smallest function/method/class enclosing the (1-based, inclusive) line
 * range of `filePath`. Falls back to the raw range ± 5 lines for unsupported
 * languages or parse failures.
 */
export async function getEnclosingContext(
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<EnclosingContext> {
  const content = await readFile(filePath, 'utf8');

  let language: Language | undefined;
  try {
    language = await loadLanguage(extname(filePath).toLowerCase());
  } catch (error) {
    log.warn(`tree-sitter failed to load for ${filePath}: ${String(error)}`);
  }
  if (!language) {
    log.warn(`No AST support for ${filePath}; using raw line context.`);
    return fallbackContext(content, startLine, endLine);
  }

  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) return fallbackContext(content, startLine, endLine);

  // tree-sitter rows are 0-based; find the node spanning the whole conflict.
  let node: Node | null = tree.rootNode.descendantForPosition(
    { row: startLine - 1, column: 0 },
    { row: endLine - 1, column: 0 },
  );

  while (node && !ENCLOSING_TYPES.has(node.type)) {
    node = node.parent;
  }

  if (!node) return fallbackContext(content, startLine, endLine);

  return {
    nodeType: node.type,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    code: node.text,
  };
}
