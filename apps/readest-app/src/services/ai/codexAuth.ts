import { clearSecureItem, getSecureItem, setSecureItem } from '@/utils/bridge';
import { isTauriAppPlatform } from '@/services/environment';
import { getAIFetch } from './utils/httpFetch';

export const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_LOGIN_URL = 'https://auth.openai.com/codex/device';
const ISSUER = 'https://auth.openai.com';
const CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const KEY = 'readest.ai.codex.oauth.v1';
// Tauri HTTP ignores the standard redirect field; use its explicit native option too.
export const codexHttp: typeof fetch = (input, init) =>
  getAIFetch()(input, Object.assign({}, init, { redirect: 'error' as const, maxRedirections: 0 }));
interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id: string;
}
export interface CodexDevice {
  user_code: string;
  device_auth_id: string;
  interval: number;
  expires_at: number;
}
let epoch = 0;
let refresh: Promise<Tokens> | null = null;

async function load(): Promise<Tokens | null> {
  if (!isTauriAppPlatform()) throw new Error('Codex OAuth 需要原生应用及系统安全存储');
  const result = await getSecureItem({ key: KEY });
  if (result.error) throw new Error('无法读取系统安全存储');
  if (!result.value) return null;
  try {
    const value = JSON.parse(result.value) as Tokens;
    if (
      typeof value.access_token !== 'string' ||
      !value.access_token ||
      typeof value.account_id !== 'string' ||
      !value.account_id ||
      typeof value.refresh_token !== 'string' ||
      !Number.isFinite(value.expires_at)
    ) {
      throw new Error('Invalid credentials');
    }
    return value;
  } catch {
    throw new Error('登录数据无效，请重新登录');
  }
}
async function save(tokens: Tokens, generation: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (generation !== epoch) throw new Error('登录已取消');
  const result = await setSecureItem({ key: KEY, value: JSON.stringify(tokens) });
  if (!result.success) throw new Error('无法保存到系统安全存储');
  if (generation !== epoch || signal?.aborted) {
    const cleared = await clearSecureItem({ key: KEY });
    if (!cleared.success) throw new Error('取消后无法清除授权，请在设置中退出登录');
    signal?.throwIfAborted();
    throw new Error('登录已取消');
  }
}
function decodeAccount(token: string): string {
  try {
    const part = token.split('.')[1]!;
    const data = JSON.parse(
      atob(
        part
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil(part.length / 4) * 4, '='),
      ),
    );
    return data['https://api.openai.com/auth']?.chatgpt_account_id || '';
  } catch {
    return '';
  }
}
async function exchange(
  body: URLSearchParams,
  previous?: Tokens,
  signal?: AbortSignal,
): Promise<Tokens> {
  const response = await codexHttp(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Codex 授权失败（HTTP ${response.status}），请重新登录`);
  const data = await response.json();
  if (!data.access_token) throw new Error('授权响应缺少令牌');
  const account_id =
    decodeAccount(data.access_token) ||
    decodeAccount(data.id_token || '') ||
    previous?.account_id ||
    '';
  if (!account_id) throw new Error('授权响应缺少 ChatGPT 账号 ID');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || previous?.refresh_token || '',
    account_id,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}
export async function codexSignedIn(): Promise<boolean> {
  return !!(await load())?.access_token;
}
export async function logoutCodex() {
  epoch++;
  const result = await clearSecureItem({ key: KEY });
  if (!result.success) throw new Error('无法清除系统安全存储');
}
export async function startCodexLogin(signal: AbortSignal): Promise<CodexDevice> {
  const response = await codexHttp(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`设备码申请失败（HTTP ${response.status}），请稍后手动重试`);
  const data = await response.json();
  if (!data.user_code || !data.device_auth_id) throw new Error('设备码响应不完整');
  return {
    user_code: data.user_code,
    device_auth_id: data.device_auth_id,
    interval: Math.max(3, Number(data.interval) || 5),
    expires_at: Date.now() + 900000,
  };
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export async function finishCodexLogin(device: CodexDevice, signal: AbortSignal) {
  const generation = epoch;
  while (Date.now() < device.expires_at) {
    await wait(device.interval * 1000, signal);
    const response = await codexHttp(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      redirect: 'error',
    });
    if (response.status === 403 || response.status === 404) continue;
    if (!response.ok) throw new Error(`授权检查失败（HTTP ${response.status}），已停止轮询`);
    const code = await response.json();
    if (!code.authorization_code || !code.code_verifier) throw new Error('授权码响应不完整');
    const tokens = await exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT,
        code: code.authorization_code,
        code_verifier: code.code_verifier,
        redirect_uri: `${ISSUER}/deviceauth/callback`,
      }),
      undefined,
      signal,
    );
    await save(tokens, generation, signal);
    return;
  }
  throw new Error('设备码已过期，请重新登录');
}
export async function codexCredentials(): Promise<Tokens> {
  const tokens = await load();
  if (!tokens) throw new Error('请先登录 Codex OAuth');
  if (tokens.expires_at > Date.now() + 60000) return tokens;
  if (!tokens.refresh_token) throw new Error('登录已过期，请重新登录');
  if (!refresh) {
    const generation = epoch;
    refresh = (async () => {
      const updated = await exchange(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT,
          refresh_token: tokens.refresh_token,
        }),
        tokens,
      );
      await save(updated, generation);
      return updated;
    })().finally(() => {
      refresh = null;
    });
  }
  return refresh;
}
