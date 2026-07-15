import { describe, it, expect, vi } from 'vitest';
import {
  buildNarrativePrompt,
  buildResolutionPrompt,
  getNarrative,
  getResolution,
  LLMResponseError,
  type NarrativeClient,
} from '../../src/core/llm.js';
import type { EnclosingContext } from '../../src/core/chunker.js';
import type { ConflictHunk, HunkContext } from '../../src/types/index.js';

const hunk: ConflictHunk = {
  headOriginLines: ['  return "hey from main";'],
  incomingLines: ['  return "hello from feature";'],
  startLine: 2,
  endLine: 6,
};

const context: HunkContext = {
  headCommits: [
    { hash: 'a1', author: 'A', date: '2026-01-01', subject: 'greet says hey from main', message: 'greet says hey from main' },
  ],
  incomingCommits: [
    { hash: 'b2', author: 'B', date: '2026-01-02', subject: 'greet says hello from feature', message: 'greet says hello from feature' },
  ],
};

describe('buildNarrativePrompt', () => {
  it('includes both sides of the code and their commit subjects', () => {
    const prompt = buildNarrativePrompt(hunk, context);
    expect(prompt).toContain('hey from main');
    expect(prompt).toContain('hello from feature');
    expect(prompt).toContain('greet says hey from main');
    expect(prompt).toContain('greet says hello from feature');
    expect(prompt).toContain('under 120 words');
  });

  it('notes when a side has no commit history', () => {
    const prompt = buildNarrativePrompt(hunk, { headCommits: context.headCommits, incomingCommits: [] });
    expect(prompt).toContain('no commit history on this side');
  });
});

describe('getNarrative', () => {
  it('sends the prompt and returns concatenated text blocks', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'Our side renamed the greeting; ' },
        { type: 'text', text: 'their side did too. Related change.' },
      ],
    });
    const client = { messages: { create } } as unknown as NarrativeClient;

    const narrative = await getNarrative(hunk, context, client);

    expect(narrative).toBe('Our side renamed the greeting; their side did too. Related change.');
    expect(create).toHaveBeenCalledOnce();
    const body = create.mock.calls[0]![0];
    expect(body.messages[0].content).toContain('hey from main');
  });
});

const astContext: EnclosingContext = {
  nodeType: 'function_declaration',
  startLine: 1,
  endLine: 3,
  code: 'function greet() {\n  return "hi";\n}',
};

const mockClient = (text: string): NarrativeClient =>
  ({
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text }] }) },
  }) as unknown as NarrativeClient;

const validResolution = {
  narrative: 'Both sides changed the greeting.',
  proposedCode: '  return "hello";',
  confidence: 'medium',
  confidenceReason: 'Both intents preserved but untested.',
};

describe('buildResolutionPrompt', () => {
  it('includes AST context, both sides, and the JSON contract', () => {
    const prompt = buildResolutionPrompt(hunk, context, astContext);
    expect(prompt).toContain('function_declaration');
    expect(prompt).toContain('hey from main');
    expect(prompt).toContain('hello from feature');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('ONLY a JSON object');
  });

  it('includes the heuristic hint when given', () => {
    const prompt = buildResolutionPrompt(hunk, context, astContext, 'formatting-only');
    expect(prompt).toContain('formatting-only');
  });
});

describe('getResolution', () => {
  it('parses a well-formed JSON response', async () => {
    const resolution = await getResolution(
      hunk,
      context,
      astContext,
      undefined,
      mockClient(JSON.stringify(validResolution)),
    );
    expect(resolution).toEqual(validResolution);
  });

  it('strips markdown fences before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify(validResolution) + '\n```';
    const resolution = await getResolution(hunk, context, astContext, undefined, mockClient(fenced));
    expect(resolution).toEqual(validResolution);
  });

  it('throws LLMResponseError with the raw response on invalid JSON', async () => {
    const promise = getResolution(hunk, context, astContext, undefined, mockClient('so sorry, no'));
    await expect(promise).rejects.toBeInstanceOf(LLMResponseError);
    await promise.catch((e: LLMResponseError) => expect(e.rawResponse).toBe('so sorry, no'));
  });

  it('throws LLMResponseError when fields are missing or mistyped', async () => {
    const missing = JSON.stringify({ narrative: 'x', confidence: 'very-high' });
    await expect(
      getResolution(hunk, context, astContext, undefined, mockClient(missing)),
    ).rejects.toBeInstanceOf(LLMResponseError);
  });
});
