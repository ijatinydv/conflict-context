import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectProvider,
  resolveModel,
  createClient,
  createOpenAiCompatibleClient,
  ProviderError,
} from '../../src/core/providers.js';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('detectProvider', () => {
  it('returns undefined when no keys are set', () => {
    expect(detectProvider(env({}))).toBeUndefined();
  });

  it('prefers anthropic, then openai, then gemini, then bluesminds', () => {
    expect(detectProvider(env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' }))).toBe('anthropic');
    expect(detectProvider(env({ OPENAI_API_KEY: 'b', GEMINI_API_KEY: 'c' }))).toBe('openai');
    expect(detectProvider(env({ GEMINI_API_KEY: 'c', BLUESMINDS_API_KEY: 'd' }))).toBe('gemini');
    expect(detectProvider(env({ BLUESMINDS_API_KEY: 'd' }))).toBe('bluesminds');
  });

  it('lets LLM_PROVIDER override detection order', () => {
    expect(
      detectProvider(env({ LLM_PROVIDER: 'bluesminds', ANTHROPIC_API_KEY: 'a' })),
    ).toBe('bluesminds');
  });

  it('rejects unknown LLM_PROVIDER values', () => {
    expect(() => detectProvider(env({ LLM_PROVIDER: 'wat' }))).toThrow(ProviderError);
  });
});

describe('resolveModel', () => {
  it('uses the provider-specific model env when set, else the default', () => {
    expect(resolveModel('anthropic', env({}))).toBe('claude-sonnet-4-6');
    expect(resolveModel('anthropic', env({ ANTHROPIC_MODEL: 'claude-x' }))).toBe('claude-x');
    expect(resolveModel('openai', env({}))).toBe('gpt-4o');
    expect(resolveModel('gemini', env({ GEMINI_MODEL: 'gemini-pro' }))).toBe('gemini-pro');
    expect(resolveModel('bluesminds', env({ BLUESMINDS_MODEL: 'llama-3' }))).toBe('llama-3');
  });
});

describe('createClient', () => {
  it('throws a ProviderError naming the missing key', () => {
    expect(() => createClient('openai', env({}))).toThrow(/OPENAI_API_KEY/);
    expect(() => createClient('bluesminds', env({}))).toThrow(/BLUESMINDS_API_KEY/);
  });
});

describe('createOpenAiCompatibleClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', defaultModel: 'gpt-4o' };
  const request = {
    model: 'gpt-4o',
    max_tokens: 100,
    messages: [{ role: 'user' as const, content: 'hello' }],
  };

  it('maps an OpenAI chat response back to the Anthropic message shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'merged code' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const message = await createOpenAiCompatibleClient(config).messages.create(request);

    expect(message.content).toEqual([{ type: 'text', text: 'merged code' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body).messages[0].content).toBe('hello');
  });

  it('throws ProviderError with status and message on HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'bad key' } }),
      }),
    );

    await expect(createOpenAiCompatibleClient(config).messages.create(request)).rejects.toThrow(
      /401.*bad key/,
    );
  });
});
