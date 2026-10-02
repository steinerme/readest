import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ signedIn: vi.fn(), start: vi.fn(), finish: vi.fn(), logout: vi.fn(), models: vi.fn(), open: vi.fn() }));
vi.mock('@/services/ai/codexAuth', () => ({ codexSignedIn: mocks.signedIn, startCodexLogin: mocks.start, finishCodexLogin: mocks.finish, logoutCodex: mocks.logout, CODEX_LOGIN_URL: 'https://auth.openai.com/codex/device' }));
vi.mock('@/services/ai/providers/CodexProvider', () => ({ DEFAULT_CODEX_MODEL: 'gpt-5.3-codex', fetchCodexModels: mocks.models }));
vi.mock('@/utils/open', () => ({ openExternalUrl: mocks.open }));
vi.mock('@/components/settings/primitives', () => ({ BoxedList: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import CodexOAuthSettings from '@/components/settings/CodexOAuthSettings';
beforeEach(() => { vi.clearAllMocks(); mocks.signedIn.mockResolvedValue(false); mocks.logout.mockResolvedValue(undefined); });
afterEach(cleanup);
it('does not automatically request login or models on opening settings', async () => {
  render(<CodexOAuthSettings onModelChange={vi.fn()} />);
  await waitFor(() => expect(mocks.signedIn).toHaveBeenCalledTimes(1));
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.models).not.toHaveBeenCalled();
});
it('shows user code, opens ONLY system browser on click, and cancels one submitted attempt', async () => {
  mocks.start.mockResolvedValue({ user_code: 'ABCD-EFGH', device_auth_id: 'device-test', interval: 5, expires_at: Date.now() + 900000 });
  mocks.finish.mockImplementation((_device, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  render(<CodexOAuthSettings onModelChange={vi.fn()} />);
  fireEvent.click(screen.getByText('获取设备码登录'));
  await screen.findByText('ABCD-EFGH');
  expect(mocks.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('在系统浏览器授权'));
  expect(mocks.open).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
  fireEvent.click(screen.getByText('取消'));
  await screen.findByText('获取设备码登录');
  expect(mocks.finish.mock.calls[0]![1].aborted).toBe(true); expect(mocks.start).toHaveBeenCalledTimes(1);
});
it('reads models explicitly and clears saved auth on logout', async () => {
  mocks.signedIn.mockResolvedValue(true); mocks.models.mockResolvedValue(['allowed-model']);
  render(<CodexOAuthSettings onModelChange={vi.fn()} />);
  await screen.findByText('已登录'); expect(mocks.models).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('刷新模型列表'));
  await waitFor(() => expect(mocks.models).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('退出登录并清除令牌'));
  await screen.findByText('未登录'); expect(mocks.logout).toHaveBeenCalledTimes(1);
});
it('aborts pending device authorization when settings unmounts', async () => {
  mocks.start.mockResolvedValue({ user_code: 'ABCD', device_auth_id: 'device-test', interval: 5, expires_at: Date.now() + 900000 });
  mocks.finish.mockReturnValue(new Promise(() => {}));
  const { unmount } = render(<CodexOAuthSettings onModelChange={vi.fn()} />);
  fireEvent.click(screen.getByText('获取设备码登录'));
  await screen.findByText('ABCD');
  const signal = mocks.finish.mock.calls[0]![1]; unmount(); expect(signal.aborted).toBe(true);
});
