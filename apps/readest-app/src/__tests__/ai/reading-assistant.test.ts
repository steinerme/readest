import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  provider: vi.fn(() => ({ getModel: () => 'mock-model' })),
}));
vi.mock('ai', () => ({ streamText: mocks.stream }));
vi.mock('@/services/ai/providers', () => ({ getAIProvider: mocks.provider }));
import { streamReadingAnswer, READING_ACTIONS } from '@/services/ai/readingAssistant';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';

const settings = { ...DEFAULT_AI_SETTINGS, enabled: true };
const passages = [{ id: 's0p0', text: '真实原文', cfi: 'cfi', sectionIndex: 0, label: '物理页 1' }];
function stream(parts: string[], reason = 'stop') {
  mocks.stream.mockReturnValue({
    textStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    finishReason: Promise.resolve(reason),
  });
}
beforeEach(() => vi.clearAllMocks());
describe('reading assistant request contract', () => {
  it('disables retries and sends only supplied evidence / bounded history', async () => {
    stream(['hello', ' world']);
    const updates: string[] = [];
    const answer = await streamReadingAnswer({
      settings,
      passages,
      scope: 'selection',
      question: '解释',
      history: [{ role: 'user', content: 'old'.repeat(5000) }],
      signal: new AbortController().signal,
      onText: (text) => updates.push(text),
    });
    expect(answer).toBe('hello world');
    expect(updates).toEqual(['hello', 'hello world']);
    const call = mocks.stream.mock.calls[0]![0];
    expect(call.maxRetries).toBe(0);
    expect(call.maxOutputTokens).toBe(2500);
    expect(call.messages[0].content.length).toBe(3000);
    expect(call.system).toContain('真实原文');
    expect(call.system).not.toContain('cfi');
  });
  it('never requests a model when disabled', async () => {
    await expect(
      streamReadingAnswer({
        settings: { ...settings, enabled: false },
        passages,
        scope: 'current',
        question: 'q',
        history: [],
        signal: new AbortController().signal,
        onText: () => {},
      }),
    ).rejects.toThrow('AI_DISABLED');
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it('refuses an empty evidence set', async () => {
    await expect(
      streamReadingAnswer({
        settings,
        passages: [],
        scope: 'all',
        question: 'q',
        history: [],
        signal: new AbortController().signal,
        onText: () => {},
      }),
    ).rejects.toThrow('NO_READABLE_TEXT');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('honors cancellation before sending', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamReadingAnswer({
        settings,
        passages,
        scope: 'all',
        question: 'q',
        history: [],
        signal: controller.signal,
        onText: () => {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('does not accept truncated partial output after cancellation', async () => {
    const controller = new AbortController();
    stream(['first', 'second']);
    await expect(
      streamReadingAnswer({
        settings,
        passages,
        scope: 'all',
        question: 'q',
        history: [],
        signal: controller.signal,
        onText: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('handles SDK streams that end silently with an error', async () => {
    stream(['partial'], 'error');
    await expect(
      streamReadingAnswer({
        settings,
        passages,
        scope: 'all',
        question: 'q',
        history: [],
        signal: new AbortController().signal,
        onText: () => {},
      }),
    ).rejects.toThrow('AI_REQUEST_FAILED');
  });
  it('rejects empty responses', async () => {
    stream([]);
    await expect(
      streamReadingAnswer({
        settings,
        passages,
        scope: 'all',
        question: 'q',
        history: [],
        signal: new AbortController().signal,
        onText: () => {},
      }),
    ).rejects.toThrow('AI_REQUEST_FAILED');
  });
  it('provides all requested selection and listening actions', () => {
    expect(Object.keys(READING_ACTIONS)).toEqual([
      'plain',
      'example',
      'argument',
      'terms',
      'translate',
      'summary',
    ]);
  });
});
