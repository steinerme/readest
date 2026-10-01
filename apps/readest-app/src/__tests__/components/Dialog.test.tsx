import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dialog from '@/components/Dialog';
import { getDialogSwipeCloseDurationMs } from '@/utils/dialogMotion';

const drag = vi.hoisted(() => ({
  move: (_data: { clientY: number; deltaY: number }) => {},
  end: (_data: { velocity: number; clientY: number; canceled: boolean }) => {},
}));
vi.mock('@/hooks/useDrag', () => ({
  useDrag: (move: typeof drag.move, _key: unknown, end: typeof drag.end) => {
    drag.move = move;
    drag.end = end;
    return { handleDragStart: vi.fn() };
  },
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { hasSafeAreaInset: true } }),
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    systemUIVisible: true,
    statusBarHeight: 24,
    safeAreaInsets: { top: 24 },
  }),
}));
vi.mock('@/store/deviceStore', () => ({ useDeviceControlStore: () => ({}) }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (n: number) => n }));
vi.mock('@/utils/rtl', () => ({ getDirFromUILanguage: () => 'ltr' }));
vi.mock('@tauri-apps/plugin-haptics', () => ({ impactFeedback: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset['eink'];
});

const ui = (open: boolean, onClose = vi.fn(), snapHeight = 0.6) => (
  <Dialog isOpen={open} title='Settings' onClose={onClose} snapHeight={snapHeight}>
    {open && <p>Body content</p>}
  </Dialog>
);

describe('Dialog motion lifecycle', () => {
  it('restores snap height and cancels stale drag cleanup on rapid reopen', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(ui(true, onClose));
    const box = container.querySelector('.modal-box') as HTMLElement;
    const overlay = container.querySelector('.overlay') as HTMLElement;
    expect(box.style.height).toBe('60%');
    act(() => drag.end({ velocity: 2, clientY: 700, canceled: false }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(box.style.transform).toBe('translateY(100%)');
    rerender(ui(false, onClose));
    act(() => vi.advanceTimersByTime(70));
    rerender(ui(true, onClose));
    expect(box.style.height).toBe('60%');
    expect(box.style.transform).toBe('');
    expect(overlay.style.opacity).toBe('');
    act(() => drag.move({ clientY: 120, deltaY: 120 }));
    const currentTransform = box.style.transform;
    act(() => vi.advanceTimersByTime(400));
    expect(box.style.transform).toBe(currentTransform);
  });

  it('retains closing content until the close transition finishes', () => {
    const { container, rerender } = render(ui(true));
    rerender(ui(false));
    expect(container.textContent).toContain('Body content');
    act(() => vi.advanceTimersByTime(299));
    expect(container.textContent).toContain('Body content');
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).not.toContain('Body content');
  });

  it('cleans up timers on unmount without later mutating the detached box', () => {
    const { container, unmount } = render(ui(true));
    const box = container.querySelector('.modal-box') as HTMLElement;
    act(() => drag.end({ velocity: 2, clientY: 700, canceled: false }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    const transform = box.style.transform;
    act(() => vi.advanceTimersByTime(400));
    expect(box.style.transform).toBe(transform);
  });

  it.each(['reduced', 'eink'])('skips programmatic close animation for %s', (mode) => {
    if (mode === 'eink') document.documentElement.dataset['eink'] = 'true';
    else
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: true })),
      );
    const onClose = vi.fn();
    const { container } = render(ui(true, onClose));
    const box = container.querySelector('.modal-box') as HTMLElement;
    act(() => drag.end({ velocity: 2, clientY: 700, canceled: false }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(box.style.transition).toBe('');
    expect(box.style.transform).toBe('');
  });

  it('keeps safe-area padding and full height across reopen', () => {
    const { container, rerender } = render(ui(true, vi.fn(), 0));
    const box = container.querySelector('.modal-box') as HTMLElement;
    rerender(ui(false, vi.fn(), 0));
    rerender(ui(true, vi.fn(), 0));
    expect(box.style.paddingTop).toBe('24px');
    expect(box.style.height).toBe('100%');
  });
});

describe('swipe velocity bounds', () => {
  it.each([
    0,
    -1,
    NaN,
    Infinity,
    0.7,
    2,
    999,
  ])('clamps velocity %s to a deliberate duration', (v) => {
    expect(getDialogSwipeCloseDurationMs(v)).toBeGreaterThanOrEqual(140);
    expect(getDialogSwipeCloseDurationMs(v)).toBeLessThanOrEqual(260);
  });
});
