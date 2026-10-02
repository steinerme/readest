import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { AIProvider, AIProviderName, AISettings } from '../types';
import { CODEX_BASE, codexCredentials, codexSignedIn, codexHttp } from '../codexAuth';

export const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';
export const CODEX_CLIENT_VERSION = '0.101.0';
// Codex uses Responses SSE, not the public API chat/completions endpoint.
export function codexFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(url);
    if (
      target.origin !== 'https://chatgpt.com' ||
      !target.pathname.startsWith('/backend-api/codex/')
    )
      throw new Error('拒绝向非 Codex 服务发送 OAuth 凭据');
    init?.signal?.throwIfAborted();
    const credentials = await codexCredentials();
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${credentials.access_token}`);
    headers.set('ChatGPT-Account-ID', credentials.account_id);
    headers.set('originator', 'readest');
    headers.set('User-Agent', 'Readest/0.12.10');
    headers.set('Accept', 'text/event-stream');
    let body = init?.body;
    if (target.pathname.endsWith('/responses') && typeof body === 'string') {
      const request = JSON.parse(body);
      request.store = false;
      request.stream = true;
      request.instructions ||= 'You are a helpful reading assistant.';
      const instructions: string[] = [];
      request.input = (request.input || []).filter(
        (item: { role?: string; content?: string | { text?: string }[] }) => {
          if (item.role !== 'system' && item.role !== 'developer') return true;
          instructions.push(
            typeof item.content === 'string'
              ? item.content
              : (item.content || []).map((part) => part.text || '').join('\n'),
          );
          return false;
        },
      );
      if (instructions.length)
        request.instructions = `${request.instructions}\n${instructions.join('\n')}`;
      // Unsupported Codex fields: omit instead of retrying a billed request.
      for (const key of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id'])
        delete request[key];
      body = JSON.stringify(request);
    }
    const response = await codexHttp(url, { ...init, body, headers, redirect: 'error' });
    if (!response.ok)
      throw new Error(
        `Codex 请求失败（HTTP ${response.status}）。请检查登录、模型权限或订阅额度。`,
      );
    return response;
  };
}
export async function fetchCodexModels(signal?: AbortSignal): Promise<string[]> {
  const response = await codexFetch()(
    `${CODEX_BASE}/models?client_version=${CODEX_CLIENT_VERSION}`,
    {
      method: 'GET',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    },
  );
  const data = await response.json();
  const list = data.models || data.data || [];
  return list
    .map((model: { slug?: string; id?: string }) => model.slug || model.id)
    .filter(Boolean);
}
export class CodexProvider implements AIProvider {
  id: AIProviderName = 'codex';
  name = 'Codex OAuth (ChatGPT)';
  requiresAuth = true;
  constructor(private settings: AISettings) {}
  getModel(): LanguageModel {
    return createOpenAI({
      apiKey: 'oauth-managed',
      baseURL: CODEX_BASE,
      fetch: codexFetch(),
    }).responses(this.settings.codexModel || DEFAULT_CODEX_MODEL);
  }
  getEmbeddingModel(): EmbeddingModel {
    throw new Error('Codex OAuth 不提供 embedding；阅读助手使用本地检索');
  }
  async isAvailable() {
    return codexSignedIn();
  }
  async healthCheck() {
    try {
      return (await fetchCodexModels()).length > 0;
    } catch {
      return false;
    }
  }
}
