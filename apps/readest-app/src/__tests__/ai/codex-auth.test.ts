import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), get: vi.fn(), set: vi.fn(), clear: vi.fn(), native: vi.fn(() => true) }));
vi.mock('@/utils/bridge', () => ({ getSecureItem: mocks.get, setSecureItem: mocks.set, clearSecureItem: mocks.clear }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: mocks.native }));
vi.mock('@/services/ai/utils/httpFetch', () => ({ getAIFetch: () => mocks.fetch }));
import { codexCredentials, codexSignedIn, startCodexLogin, finishCodexLogin, logoutCodex } from '@/services/ai/codexAuth';
const jwt = `header.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } }))}.signature`;
const tokens = { access_token: jwt, refresh_token: 'test-refresh', expires_at: Date.now() + 3600000, account_id: 'account-test' };
const ok = (data: object) => ({ ok: true, status: 200, json: async () => data });
beforeEach(() => { vi.clearAllMocks(); mocks.native.mockReturnValue(true); mocks.get.mockResolvedValue({}); mocks.set.mockResolvedValue({ success: true }); mocks.clear.mockResolvedValue({ success: true }); });
afterEach(() => vi.useRealTimers());
describe('Codex device OAuth', () => {
  it('does not contact OAuth simply checking saved status', async () => {
    expect(await codexSignedIn()).toBe(false); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('rejects web storage rather than falling back to localStorage', async () => {
    mocks.native.mockReturnValue(false);
    await expect(codexSignedIn()).rejects.toThrow('原生应用'); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('requests public client device code and honors minimum polling interval', async () => {
    mocks.fetch.mockResolvedValue(ok({ user_code: 'ABCD-EFGH', device_auth_id: 'test-device', interval: '1' }));
    const result = await startCodexLogin(new AbortController().signal);
    expect(result.interval).toBe(3);
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(init.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
    expect(init.redirect).toBe('error');
    expect(init.maxRedirections).toBe(0);
  });
  it('fails once on 429 without automated repeated login', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 429 });
    await expect(startCodexLogin(new AbortController().signal)).rejects.toThrow('429');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('polls pending then exchanges PKCE and saves only to keyed secure store', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(ok({ authorization_code: 'test-code', code_verifier: 'test-verifier' }))
      .mockResolvedValueOnce(ok({ access_token: jwt, refresh_token: 'test-refresh', expires_in: 3600 }));
    const promise = finishCodexLogin({ user_code: 'ABCD', device_auth_id: 'device', interval: 3, expires_at: Date.now() + 900000 }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(6000); await promise;
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    const [, exchange] = mocks.fetch.mock.calls[2]!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBe('test-verifier');
    expect(new URLSearchParams(exchange.body).get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    const saved = mocks.set.mock.calls[0]![0];
    expect(saved.key).toBe('readest.ai.codex.oauth.v1');
    expect(JSON.parse(saved.value).account_id).toBe('account-test');
  });
  it('cancels waiting without exchange or secure write', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const promise = finishCodexLogin({ user_code: 'ABCD', device_auth_id: 'device', interval: 3, expires_at: Date.now() + 900000 }, controller.signal);
    const assertion = expect(promise).rejects.toBeDefined(); controller.abort(); await assertion;
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.set).not.toHaveBeenCalled();
  });
  it('shares one refresh and preserves unrotated refresh token', async () => {
    mocks.get.mockResolvedValue({ value: JSON.stringify({ ...tokens, expires_at: 0 }) });
    mocks.fetch.mockResolvedValue(ok({ access_token: jwt, expires_in: 3600 }));
    const result = await Promise.all([codexCredentials(), codexCredentials()]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(result[0]!.refresh_token).toBe('test-refresh');
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });
  it('logout clears only the Codex secure namespace', async () => {
    await logoutCodex(); expect(mocks.clear).toHaveBeenCalledWith({ key: 'readest.ai.codex.oauth.v1' });
  });
  it('does not resurrect tokens when logout wins refresh race', async () => {
    mocks.get.mockResolvedValue({ value: JSON.stringify({ ...tokens, expires_at: 0 }) });
    let resolve!: (value: unknown) => void;
    mocks.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
    const promise = codexCredentials();
    const assertion = expect(promise).rejects.toThrow('取消');
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await logoutCodex(); resolve(ok({ access_token: jwt })); await assertion;
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('never includes token exchange response body in errors', async () => {
    mocks.get.mockResolvedValue({ value: JSON.stringify({ ...tokens, expires_at: 0 }) });
    mocks.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'secret-token-value' });
    await expect(codexCredentials()).rejects.toThrow('HTTP 401'); expect(mocks.set).not.toHaveBeenCalled();
  });
});
