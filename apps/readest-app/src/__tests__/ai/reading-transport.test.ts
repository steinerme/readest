import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/services/ai/utils/httpFetch', () => ({ getAIFetch: () => m.fetch }));
import { streamReadingAnswer } from '@/services/ai/readingAssistant';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
const settings = {
  ...DEFAULT_AI_SETTINGS,
  enabled: true,
  provider: 'openrouter' as const,
  openrouterBaseUrl: 'https://synthetic.invalid/v1',
  openrouterApiKey: 'SYNTHETIC_TEST_ONLY',
  openrouterModel: 'test-model',
};
const options = () => ({
  settings,
  passages: [
    {
      id: 's0p0',
      text: 'Synthetic public sample.',
      cfi: 'synthetic-cfi',
      sectionIndex: 0,
      label: 'page 1',
    },
  ],
  scope: 'selection' as const,
  question: 'Explain this.',
  history: [],
  signal: new AbortController().signal,
  onText: vi.fn(),
});
beforeEach(() => vi.clearAllMocks());
describe('reading assistant actual SDK transport', () => {
  it('uses configured /chat/completions and parses SSE without embedding calls', async () => {
    const events = [
      {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [
          { index: 0, delta: { role: 'assistant', content: '解释 ' }, finish_reason: null },
        ],
      },
      {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: { content: '[s0p0]' }, finish_reason: null }],
      },
      {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];
    m.fetch.mockResolvedValue(
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      ),
    );
    expect(await streamReadingAnswer(options())).toBe('解释 [s0p0]');
    expect(m.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = m.fetch.mock.calls[0]!;
    expect(url).toBe('https://synthetic.invalid/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toContain('Synthetic public sample.');
    expect(init.signal).toBeTruthy();
  });
  it('does not retry a rate limited compatible backend', async () => {
    m.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(streamReadingAnswer(options())).rejects.toThrow();
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });
});
