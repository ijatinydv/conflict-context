import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnclosingContext } from '../../src/core/chunker.js';

describe('getEnclosingContext', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-chunk-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds the enclosing function around a conflict', async () => {
    const file = join(dir, 'fn.ts');
    await writeFile(
      file,
      [
        'const x = 1;',
        '',
        'function target(a: number) {',
        '<<<<<<< HEAD',
        '  return a + 1;',
        '=======',
        '  return a + 2;',
        '>>>>>>> feature',
        '}',
        '',
        'const y = 2;',
      ].join('\n'),
    );

    const ctx = await getEnclosingContext(file, 4, 8);
    expect(ctx.nodeType).toBe('function_declaration');
    expect(ctx.startLine).toBe(3);
    expect(ctx.endLine).toBe(9);
    expect(ctx.code).toContain('function target');
  });

  it('finds the enclosing method inside a class', async () => {
    const file = join(dir, 'cls.ts');
    await writeFile(
      file,
      [
        'class Greeter {',
        '  private name = "x";',
        '',
        '  greet() {',
        '<<<<<<< HEAD',
        '    return `hey ${this.name}`;',
        '=======',
        '    return `hello ${this.name}`;',
        '>>>>>>> feature',
        '  }',
        '}',
      ].join('\n'),
    );

    const ctx = await getEnclosingContext(file, 5, 9);
    expect(ctx.nodeType).toBe('method_definition');
    expect(ctx.code).toContain('greet()');
    expect(ctx.code).not.toContain('class Greeter');
  });

  it('falls back to raw line context for unsupported languages', async () => {
    const file = join(dir, 'main.rs');
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    await writeFile(file, lines.join('\n'));

    const ctx = await getEnclosingContext(file, 10, 12);
    expect(ctx.nodeType).toBe('fallback');
    expect(ctx.startLine).toBe(5);
    expect(ctx.endLine).toBe(17);
    expect(ctx.code).toContain('line 10');
    expect(ctx.code).toContain('line 17');
    expect(ctx.code).not.toContain('line 18');
  });

  it('falls back when the conflict is at top level with no enclosing declaration', async () => {
    const file = join(dir, 'top.ts');
    await writeFile(
      file,
      ['<<<<<<< HEAD', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> feature'].join('\n'),
    );

    const ctx = await getEnclosingContext(file, 1, 5);
    expect(ctx.nodeType).toBe('fallback');
  });
});
