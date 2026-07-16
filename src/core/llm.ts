/**
 * LLM layer: turn a conflict hunk plus its commit history into a narrative,
 * or a full structured Resolution. Provider-agnostic — the active provider
 * (Anthropic, OpenAI, Gemini, BluesMinds) is picked from env by providers.ts,
 * and the client is injectable so tests never hit the network. Env is read
 * here but loaded by the CLI entrypoint via dotenv.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  createClient,
  detectProvider,
  resolveModel,
  ProviderError,
  type NarrativeClient,
} from './providers.js';
import type { ConflictHunk, HunkContext, CommitInfo, Resolution } from '../types/index.js';
import type { EnclosingContext } from './chunker.js';

export type { NarrativeClient } from './providers.js';

/** Raised when the model's response cannot be parsed into the expected shape. */
export class LLMResponseError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string,
  ) {
    super(message);
    this.name = 'LLMResponseError';
  }
}

function formatCommits(commits: CommitInfo[]): string {
  if (commits.length === 0) return '  (no commit history on this side)';
  return commits.map((c) => `  - ${c.subject}`).join('\n');
}

export function buildNarrativePrompt(hunk: ConflictHunk, context: HunkContext): string {
  const head = hunk.headOriginLines.join('\n');
  const incoming = hunk.incomingLines.join('\n');

  return [
    'You are helping a developer understand a git merge conflict they have lost the context for.',
    'Below is one conflicting hunk with the recent commit history behind each side.',
    '',
    '=== OUR side (HEAD) code ===',
    head,
    '',
    'Recent commits that shaped OUR side:',
    formatCommits(context.headCommits),
    '',
    '=== THEIR side (incoming) code ===',
    incoming,
    '',
    'Recent commits that shaped THEIR side:',
    formatCommits(context.incomingCommits),
    '',
    'Explain, in plain English and under 120 words:',
    '(a) what each side was trying to accomplish,',
    '(b) whether there is an obvious relationship between the two changes.',
    'Write readable prose for a developer. Do not propose a merged resolution yet.',
  ].join('\n');
}

let cachedClient: NarrativeClient | undefined;

function getClient(): NarrativeClient {
  if (!cachedClient) {
    const provider = detectProvider();
    if (!provider) {
      throw new ProviderError(
        'No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY ' +
          'in your environment or a .env file.',
      );
    }
    cachedClient = createClient(provider);
  }
  return cachedClient;
}

async function requestText(
  client: NarrativeClient,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const provider = detectProvider() ?? 'anthropic';
  const message = await client.messages.create({
    model: resolveModel(provider),
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

export async function getNarrative(
  hunk: ConflictHunk,
  context: HunkContext,
  client: NarrativeClient = getClient(),
): Promise<string> {
  return requestText(client, buildNarrativePrompt(hunk, context), 400);
}

export function buildResolutionPrompt(
  hunk: ConflictHunk,
  context: HunkContext,
  astContext: EnclosingContext,
  classificationHint?: string,
): string {
  return [
    'You are resolving one git merge conflict hunk. Use the surrounding code and each',
    "side's commit history to propose a merged version that preserves both intents",
    'where possible.',
    '',
    `=== Enclosing code (${astContext.nodeType}, lines ${astContext.startLine}-${astContext.endLine}) ===`,
    astContext.code,
    '',
    '=== OUR side (HEAD) ===',
    hunk.headOriginLines.join('\n'),
    '',
    'Commits behind OUR side:',
    formatCommits(context.headCommits),
    '',
    '=== THEIR side (incoming) ===',
    hunk.incomingLines.join('\n'),
    '',
    'Commits behind THEIR side:',
    formatCommits(context.incomingCommits),
    '',
    ...(classificationHint
      ? [`Heuristic pre-classification of this conflict: ${classificationHint}`, '']
      : []),
    'Respond with ONLY a JSON object — no prose outside it, no markdown fences — with',
    'exactly these fields:',
    '{',
    '  "narrative": "plain-English explanation of what each side was doing (under 120 words)",',
    '  "proposedCode": "the merged replacement for the conflicted region, markers removed",',
    '  "confidence": "high" | "medium" | "low",',
    '  "confidenceReason": "one sentence on why you chose that confidence"',
    '}',
  ].join('\n');
}

/** Models sometimes wrap JSON in ```json fences despite instructions; strip them. */
function stripMarkdownFences(text: string): string {
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return match?.[1] ?? text;
}

function parseResolution(raw: string): Resolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFences(raw));
  } catch {
    throw new LLMResponseError('Model response is not valid JSON', raw);
  }

  const r = parsed as Partial<Resolution>;
  if (
    typeof r.narrative !== 'string' ||
    typeof r.proposedCode !== 'string' ||
    typeof r.confidenceReason !== 'string' ||
    (r.confidence !== 'high' && r.confidence !== 'medium' && r.confidence !== 'low')
  ) {
    throw new LLMResponseError('Model response JSON is missing or mistyping required fields', raw);
  }

  return {
    narrative: r.narrative,
    proposedCode: r.proposedCode,
    confidence: r.confidence,
    confidenceReason: r.confidenceReason,
  };
}

export async function getResolution(
  hunk: ConflictHunk,
  context: HunkContext,
  astContext: EnclosingContext,
  classificationHint?: string,
  client: NarrativeClient = getClient(),
): Promise<Resolution> {
  const raw = await requestText(
    client,
    buildResolutionPrompt(hunk, context, astContext, classificationHint),
    1500,
  );
  return parseResolution(raw);
}
