/**
 * Provider selection for the LLM layer. Anthropic uses its own SDK; OpenAI,
 * Gemini, and BluesMinds all speak the OpenAI chat-completions dialect, so a
 * single fetch-based adapter (mapped back to the Anthropic message shape that
 * NarrativeClient expects) covers the other three.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Minimal surface of the Anthropic client the LLM layer depends on. */
export interface NarrativeClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'bluesminds';

interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

const OPENAI_COMPATIBLE: Record<
  Exclude<ProviderName, 'anthropic'>,
  { keyEnv: string; modelEnv: string; defaultBase: string; defaultModel: string; baseEnv?: string }
> = {
  openai: {
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
  },
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
  },
  bluesminds: {
    keyEnv: 'BLUESMINDS_API_KEY',
    modelEnv: 'BLUESMINDS_MODEL',
    defaultBase: 'https://api.bluesminds.com/v1',
    defaultModel: 'gpt-4o',
    baseEnv: 'BLUESMINDS_BASE',
  },
};

const DETECTION_ORDER: ProviderName[] = ['anthropic', 'openai', 'gemini', 'bluesminds'];

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** LLM_PROVIDER wins when set; otherwise the first provider with a key set. */
export function detectProvider(env: NodeJS.ProcessEnv = process.env): ProviderName | undefined {
  const explicit = env.LLM_PROVIDER?.toLowerCase();
  if (explicit) {
    if (!DETECTION_ORDER.includes(explicit as ProviderName)) {
      throw new ProviderError(
        `Unknown LLM_PROVIDER "${explicit}" — use anthropic, openai, gemini, or bluesminds.`,
      );
    }
    return explicit as ProviderName;
  }
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  for (const name of DETECTION_ORDER.slice(1) as Exclude<ProviderName, 'anthropic'>[]) {
    if (env[OPENAI_COMPATIBLE[name].keyEnv]) return name;
  }
  return undefined;
}

/** The model the active provider will use (its own env var, or its default). */
export function resolveModel(
  provider: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (provider === 'anthropic') return env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const cfg = OPENAI_COMPATIBLE[provider];
  return env[cfg.modelEnv] ?? cfg.defaultModel;
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

/**
 * Wraps an OpenAI-compatible /chat/completions endpoint behind the
 * NarrativeClient interface, translating the response back into the Anthropic
 * message shape so the rest of the LLM layer stays provider-agnostic.
 */
export function createOpenAiCompatibleClient(config: OpenAiCompatibleConfig): NarrativeClient {
  return {
    messages: {
      async create(body) {
        const prompt = body.messages
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n');

        const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: body.model || config.defaultModel,
            max_tokens: body.max_tokens,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const data = (await response.json().catch(() => ({}))) as OpenAiChatResponse;
        if (!response.ok) {
          throw new ProviderError(
            `Provider request failed (${response.status}): ${data.error?.message ?? response.statusText}`,
          );
        }

        const text = data.choices?.[0]?.message?.content ?? '';
        return { content: [{ type: 'text', text }] } as Anthropic.Message;
      },
    },
  };
}

export function createClient(
  provider: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
): NarrativeClient {
  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ProviderError('ANTHROPIC_API_KEY is not set.');
    return new Anthropic({ apiKey });
  }

  const cfg = OPENAI_COMPATIBLE[provider];
  const apiKey = env[cfg.keyEnv];
  if (!apiKey) throw new ProviderError(`${cfg.keyEnv} is not set.`);
  const baseUrl = (cfg.baseEnv && env[cfg.baseEnv]) || cfg.defaultBase;
  return createOpenAiCompatibleClient({
    baseUrl,
    apiKey,
    defaultModel: resolveModel(provider, env),
  });
}
