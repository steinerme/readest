import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { eventDispatcher } from '@/utils/event';
const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  prev: vi.fn(),
  next: vi.fn(),
  prevSection: vi.fn(),
  nextSection: vi.fn(),
  fraction: vi.fn(),
  setConfig: vi.fn(),
  sidebar: vi.fn(),
  hovered: vi.fn(),
  setTab: vi.fn(),
  enabled: false,
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: { isMobile: true } }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/store/deviceStore', () => ({
  useDeviceControlStore: () => ({
    acquireBackKeyInterception: vi.fn(),
    releaseBackKeyInterception: vi.fn(),
  }),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({
    isSideBarVisible: false,
    isSideBarPinned: false,
    setSideBarVisible: h.sidebar,
  }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => ({ viewSettings: {} }),
    setConfig: h.setConfig,
    getBookData: () => ({ isFixedLayout: true }),
  }),
}));
const view = {
  renderer: {
    getContents: () => [],
    prev: h.prev,
    next: h.next,
    prevSection: h.prevSection,
    nextSection: h.nextSection,
  },
  goToFraction: h.fraction,
  history: { back: vi.fn(), forward: vi.fn() },
};
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    hoveredBookKey: 'b1',
    setHoveredBookKey: h.hovered,
    bottomBarTab: '',
    setBottomBarTab: h.setTab,
    getView: () => view,
    getViewState: () => ({ ttsEnabled: h.enabled }),
    getProgress: () => ({ section: { current: 4, total: 30 } }),
    getViewSettings: () => ({}),
  }),
}));
vi.mock('@/app/reader/hooks/useSpatialNavigation', () => ({ useSpatialNavigation: () => {} }));
vi.mock('@/app/reader/components/rsvp', () => ({ RSVPControl: () => null }));
vi.mock('@/app/reader/components/tts/TTSControl', () => ({ default: () => null }));
vi.mock('@/app/reader/components/footerbar/DesktopFooterBar', () => ({ default: () => null }));
vi.mock('@/app/reader/components/footerbar/MobileFooterBar', () => ({
  default: ({ navigationHandlers: n, onSetActionTab: tab, progressFraction }: any) => (
    <div>
      <output data-testid='progress'>{progressFraction}</output>
      <button onClick={n.onPrevPage}>Previous Page</button>
      <button onClick={n.onNextPage}>Next Page</button>
      <button onClick={() => n.onProgressChange(100)}>Progress End</button>
      <button onClick={() => tab('toc')}>TOC</button>
      <button onClick={() => tab('tts')}>Read Aloud</button>
    </div>
  ),
}));
import FooterBar from '@/app/reader/components/footerbar/FooterBar';
const props = {
  bookKey: 'b1',
  bookFormat: 'PDF' as const,
  section: { current: 4, total: 30 },
  pageinfo: { current: 4, next: 5, total: 30 },
  isHoveredAnim: false,
  gridInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = false;
  h.navigate.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  usePdfReflowStore.setState({ sessions: {} });
  vi.useRealTimers();
});
describe('same original footer UI, mode-aware services', () => {
  it('keeps PDF original navigation unchanged', () => {
    render(<FooterBar {...props} />);
    fireEvent.click(screen.getByText('Previous Page'));
    fireEvent.click(screen.getByText('Next Page'));
    expect(h.prev).toHaveBeenCalledOnce();
    expect(h.next).toHaveBeenCalledOnce();
  });
  it('routes reflow page and progress controls to its real page service', () => {
    vi.useFakeTimers();
    usePdfReflowStore
      .getState()
      .setSession('b1', {
        page: 44,
        count: 307,
        navigate: h.navigate,
        close: vi.fn(),
        speak: async () => {},
        returnToSpeech: vi.fn(),
      });
    render(<FooterBar {...props} />);
    expect(Number(screen.getByTestId('progress').textContent)).toBeCloseTo(45 / 307);
    fireEvent.click(screen.getByText('Previous Page'));
    fireEvent.click(screen.getByText('Next Page'));
    fireEvent.click(screen.getByText('Progress End'));
    act(() => vi.advanceTimersByTime(120));
    expect(h.navigate).toHaveBeenCalledWith(43);
    expect(h.navigate).toHaveBeenCalledWith(45);
    expect(h.navigate).toHaveBeenCalledWith(306);
    expect(h.prev).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
  });
  it('opens the same TOC sidebar and starts the same TTS service from the visible page', () => {
    usePdfReflowStore
      .getState()
      .setSession('b1', {
        page: 44,
        count: 307,
        navigate: h.navigate,
        close: vi.fn(),
        speak: async () => {},
        returnToSpeech: vi.fn(),
      });
    const speak = vi.fn();
    eventDispatcher.on('tts-speak', speak);
    try {
      render(<FooterBar {...props} />);
      fireEvent.click(screen.getByText('TOC'));
      expect(h.sidebar).toHaveBeenCalledWith(true);
      fireEvent.click(screen.getByText('Read Aloud'));
      expect(speak).toHaveBeenCalledWith(
        expect.objectContaining({ detail: { bookKey: 'b1', index: 44 } }),
      );
    } finally {
      eventDispatcher.off('tts-speak', speak);
    }
  });
});
