import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), credentials: vi.fn(), signedIn: vi.fn() }));
vi.mock('@/services/ai/codexAuth', () => ({ CODEX_BASE: 'https://chatgpt.com/backend-api/codex', codexCredentials: mocks.credentials, codexSignedIn: mocks.signedIn, codexHttp: mocks.fetch }));
vi.mock('@/services/ai/utils/httpFetch', () => ({ getAIFetch: () => mocks.fetch }));
import { CodexProvider, codexFetch, fetchCodexModels } from '@/services/ai/providers/CodexProvider';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
beforeEach(() => { vi.clearAllMocks(); mocks.credentials.mockResolvedValue({ access_token: 'test-token', account_id: 'test-account' }); });
describe('Codex Responses transport', () => {
  it('rejects token delivery to other origins', async () => {
    await expect(codexFetch()('https://evil.example/responses')).rejects.toThrow('拒绝');
    expect(mocks.credentials).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('sets account identity, store=false and required instructions; removes incompatible fields', async () => {
    mocks.fetch.mockResolvedValue(new Response(''));
    await codexFetch()('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: JSON.stringify({ input: [{ role: 'developer', content: [{ type: 'input_text', text: 'reading rules' }] }, { role: 'user', content: 'Explain' }], temperature: 0.3, max_output_tokens: 500 }) });
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toContain('/responses'); expect(init.headers.get('Authorization')).toBe('Bearer test-token');
    expect(init.headers.get('ChatGPT-Account-ID')).toBe('test-account'); expect(init.redirect).toBe('error');
    const body = JSON.parse(init.body); expect(body.store).toBe(false); expect(body.stream).toBe(true);
    expect(body.instructions).toContain('reading rules'); expect(body.input).toHaveLength(1);
    expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('max_output_tokens');
  });
  it('reports HTTP failure without surfacing sensitive body or retrying', async () => {
    mocks.fetch.mockResolvedValue(new Response('echo secret', { status: 401 }));
    await expect(codexFetch()('https://chatgpt.com/backend-api/codex/responses')).rejects.toThrow('HTTP 401');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation before loading credentials', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(codexFetch()('https://chatgpt.com/backend-api/codex/responses', { signal: controller.signal })).rejects.toBeDefined();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
  it('fetches models on demand with version and recognizes slug', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: 'gpt-5.3-codex' }, { id: 'model-two' }] })));
    expect(await fetchCodexModels()).toEqual(['gpt-5.3-codex', 'model-two']);
    expect(mocks.fetch.mock.calls[0]![0]).toContain('client_version=');
  });
  it('does not pretend Codex provides embedding', () => {
    const provider = new CodexProvider({ ...DEFAULT_AI_SETTINGS, provider: 'codex' });
    expect(() => provider.getEmbeddingModel()).toThrow('embedding');
  });
  it('real SDK decodes Codex response text SSE on Responses endpoint', async () => {
    const events = [
      { type: 'response.created', response: { id: 'resp_test', created_at: 1, model: 'gpt-5.3-codex' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_test', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', output_index: 0, item_id: 'msg_test', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: '原文解释 [P1]' },
      { type: 'response.output_text.done', item_id: 'msg_test', output_index: 0, content_index: 0, text: '原文解释 [P1]' },
      { type: 'response.completed', response: { id: 'resp_test', created_at: 1, model: 'gpt-5.3-codex', status: 'completed', usage: { input_tokens: 20, output_tokens: 6, total_tokens: 26, output_tokens_details: { reasoning_tokens: 0 }, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    mocks.fetch.mockResolvedValue(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    const provider = new CodexProvider({ ...DEFAULT_AI_SETTINGS, provider: 'codex' });
    const result = streamText({ model: provider.getModel(), system: '只解释提供的原文', prompt: '解释这句话', maxRetries: 0 });
    let text = ''; for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe('原文解释 [P1]');
    expect(mocks.fetch.mock.calls[0]![0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body).instructions).toContain('只解释提供的原文');
  });
});
