/**
 * LLM layer for phase 1: turn a conflict hunk plus its commit history into a
 * short, plain-English narrative of what each side was trying to do.
 *
 * Environment (ANTHROPIC_API_KEY, ANTHROPIC_MODEL) is read here but loaded by
 * the CLI entrypoint via dotenv — this module never touches the filesystem.
 * The Anthropic client is injectable so getNarrative can be tested without
 * real network calls.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ConflictHunk, HunkContext, CommitInfo } from '../types/index.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Minimal surface of the Anthropic client that getNarrative depends on. */
export interface NarrativeClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set. Add it to your environment or a .env file.');
    }
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

export async function getNarrative(
  hunk: ConflictHunk,
  context: HunkContext,
  client: NarrativeClient = getClient(),
): Promise<string> {
  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const message = await client.messages.create({
    model,
    max_tokens: 400,
    messages: [{ role: 'user', content: buildNarrativePrompt(hunk, context) }],
  });

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}
