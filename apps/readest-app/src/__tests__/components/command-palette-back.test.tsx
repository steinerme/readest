import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { eventDispatcher } from '@/utils/event';
import { useDeviceControlStore } from '@/store/deviceStore';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  isOpen: true,
  android: true,
  intercept: vi.fn(async () => {}),
}));
vi.mock('@/utils/bridge', () => ({
  interceptKeys: mocks.intercept,
  getScreenBrightness: vi.fn(),
  setScreenBrightness: vi.fn(),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { isAndroidApp: mocks.android } }),
}));
vi.mock('@/components/command-palette/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({
    isOpen: mocks.isOpen,
    close: mocks.close,
    query: '',
    setQuery: vi.fn(),
    results: [],
    groupedResults: { settings: [], actions: [], navigation: [] },
    recentItems: [],
    executeCommand: vi.fn(),
  }),
}));
import CommandPalette from '@/components/command-palette/CommandPalette';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isOpen = true;
  mocks.android = true;
  useDeviceControlStore.setState({ backKeyInterceptionCount: 0, backKeyIntercepted: false });
});
afterEach(cleanup);

describe('command palette and Android Back', () => {
  it('consumes a single native Back and closes the palette', () => {
    render(<CommandPalette />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(useDeviceControlStore.getState().backKeyIntercepted).toBe(true);
    const consumed = eventDispatcher.dispatchSync('native-key-down', { keyName: 'Back' });
    expect(consumed).toBe(true);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('ignores other native keys and releases the interception when closed', () => {
    const { rerender } = render(<CommandPalette />);
    expect(eventDispatcher.dispatchSync('native-key-down', { keyName: 'VolumeUp' })).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();
    mocks.isOpen = false;
    rerender(<CommandPalette />);
    expect(useDeviceControlStore.getState().backKeyIntercepted).toBe(false);
    expect(eventDispatcher.dispatchSync('native-key-down', { keyName: 'Back' })).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('does not touch native key interception off Android', () => {
    mocks.android = false;
    render(<CommandPalette />);
    expect(useDeviceControlStore.getState().backKeyIntercepted).toBe(false);
  });
});
