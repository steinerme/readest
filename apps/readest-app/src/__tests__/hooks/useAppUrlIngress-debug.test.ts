import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openUrl: null as ((urls: string[]) => void) | null,
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(async (cb: (urls: string[]) => void) => {
    h.openUrl = cb;
    return () => {};
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: vi.fn(async () => () => {}) }),
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { isAndroidApp: false } }),
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));

import { useAppUrlIngress } from '@/hooks/useAppUrlIngress';
import { eventDispatcher } from '@/utils/event';

const app = vi.fn();
const debug = vi.fn();
beforeEach(() => {
  eventDispatcher.on('app-incoming-url', app);
  eventDispatcher.on('debug-selection-url', debug);
});
afterEach(() => {
  eventDispatcher.off('app-incoming-url', app);
  eventDispatcher.off('debug-selection-url', debug);
  vi.unstubAllEnvs();
  app.mockClear();
  debug.mockClear();
});

describe('preview debug links never reach book/file consumers', () => {
  it('routes them to the debug channel in preview builds', async () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_DEBUG_LINKS', '1');
    renderHook(() => useAppUrlIngress());
    await vi.waitFor(() => expect(h.openUrl).toBeTruthy());
    h.openUrl!(['readest-preview-debug://select?text=x', 'readest://book/abc']);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]![0].detail.urls).toEqual(['readest-preview-debug://select?text=x']);
    expect(app.mock.calls[0]![0].detail.urls).toEqual(['readest://book/abc']);
  });
  it('drops them silently when the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_DEBUG_LINKS', '');
    renderHook(() => useAppUrlIngress());
    await vi.waitFor(() => expect(h.openUrl).toBeTruthy());
    h.openUrl!(['readest-preview-debug://select?text=x']);
    expect(debug).not.toHaveBeenCalled();
    expect(app).not.toHaveBeenCalled();
  });
});
