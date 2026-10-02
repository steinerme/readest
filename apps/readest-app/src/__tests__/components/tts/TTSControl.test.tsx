import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useTTSPlayerHostStore } from '@/store/ttsPlayerHostStore';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } }),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    hoveredBookKey: '',
    getViewSettings: () => ({ isEink: false, rtl: false }),
  }),
}));

const ttsState: Record<string, unknown> = {};
vi.mock('@/app/reader/hooks/useTTSControl', () => ({
  useTTSControl: () => ttsState,
}));

vi.mock('@/app/reader/hooks/useTTSDownloads', () => ({
  useTTSDownloads: () => ({
    supported: false,
    chapters: [],
    statuses: new Map(),
    cacheBytes: 0,
    clearing: false,
    items: [],
    itemFor: () => undefined,
    downloadChapter: vi.fn(),
    downloadAll: vi.fn(),
    cancelChapter: vi.fn(),
    cancelAll: vi.fn(),
    clearDownloads: vi.fn(),
    statusOf: () => 'none',
    refresh: vi.fn(),
  }),
}));

vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({ index: 0 }),
}));

vi.mock('@/app/reader/components/tts/TTSMiniPlayer', () => ({
  __esModule: true,
  default: ({ onExpand, buffering }: { onExpand: () => void; buffering: boolean }) => (
    <div data-testid='mini-player' aria-busy={buffering} onClick={onExpand} />
  ),
}));

vi.mock('@/app/reader/components/tts/TTSPlayerSheet', () => ({
  __esModule: true,
  default: ({
    isOpen,
    activeSectionIndex,
    onSetRate,
    onSeek,
    onClose,
  }: {
    isOpen: boolean;
    activeSectionIndex: number | null;
    onSetRate: (rate: number) => void;
    onSeek: (seconds: number) => void;
    onClose: () => void;
  }) =>
    isOpen ? (
      <div data-testid='player-sheet' data-active-section={activeSectionIndex}>
        <button onClick={() => onSetRate(1.5)}>Rate 1.5</button>
        <button onClick={() => onSeek(42)}>Seek 42</button>
        <button onClick={onClose}>Close Player</button>
      </div>
    ) : null,
}));

import TTSControl from '@/app/reader/components/tts/TTSControl';

const gridInsets = { top: 0, right: 0, bottom: 0, left: 0 };

describe('TTSControl', () => {
  beforeEach(() => {
    Object.assign(ttsState, {
      isPlaying: true,
      buffering: false,
      ttsLang: 'en',
      ttsClientsInited: true,
      showIndicator: true,
      showBackToCurrentTTSLocation: false,
      ttsSectionIndex: 2,
      getController: () => null,
      timeoutOption: 0,
      timeoutTimestamp: 0,
      chapterRemainingSec: null,
      handleTogglePlay: vi.fn(),
      handleBackward: vi.fn(),
      handleForward: vi.fn(),
      handleSetRate: vi.fn(),
      handleGetVoices: vi.fn(),
      handleSetVoice: vi.fn(),
      handleGetVoiceId: vi.fn().mockReturnValue(''),
      handleSelectTimeout: vi.fn(),
      handleBackToCurrentTTSLocation: vi.fn(),
      handleSeekTo: vi.fn(),
      handleGetPlaybackInfo: vi.fn().mockReturnValue(null),
      handleSetSentenceGap: vi.fn(),
      handleSupportsPlaybackInfo: vi.fn().mockReturnValue(true),
      audioTransport: false,
      handleSupportsGapControl: vi.fn().mockReturnValue(false),
      refreshTtsLang: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    useTTSPlayerHostStore.setState({ hosts: {} });
    document.querySelectorAll('[data-test-host]').forEach((host) => host.remove());
    vi.clearAllMocks();
  });

  test('mounts the mini player while a session is active', () => {
    render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    expect(screen.getByTestId('mini-player')).toBeTruthy();
    expect(screen.queryByTestId('player-sheet')).toBeNull();
  });

  test('renders nothing while no session is active', () => {
    Object.assign(ttsState, { showIndicator: false, ttsClientsInited: false });
    render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    expect(screen.queryByTestId('mini-player')).toBeNull();
    expect(screen.queryByTestId('player-sheet')).toBeNull();
  });

  test('mounts the mini player immediately, before the clients are initialized', () => {
    Object.assign(ttsState, { showIndicator: true, ttsClientsInited: false });
    render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    expect(screen.getByTestId('mini-player')).toBeTruthy();
    // Expanding needs initialized clients; taps are ignored until then.
    fireEvent.click(screen.getByTestId('mini-player'));
    expect(screen.queryByTestId('player-sheet')).toBeNull();
    expect(screen.getByTestId('mini-player')).toBeTruthy();
  });

  test('shows loading throughout initialization, then follows audio buffering', () => {
    Object.assign(ttsState, { ttsClientsInited: false, buffering: false });
    const { rerender } = render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    expect(screen.getByTestId('mini-player').getAttribute('aria-busy')).toBe('true');
    ttsState['ttsClientsInited'] = true;
    rerender(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    expect(screen.getByTestId('mini-player').getAttribute('aria-busy')).toBe('false');
    ttsState['buffering'] = true;
    rerender(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    expect(screen.getByTestId('mini-player').getAttribute('aria-busy')).toBe('true');
  });

  test('expanding the mini player opens the sheet and hides the mini player', () => {
    render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    fireEvent.click(screen.getByTestId('mini-player'));
    expect(screen.getByTestId('player-sheet')).toBeTruthy();
    // The two surfaces never show at the same time.
    expect(screen.queryByTestId('mini-player')).toBeNull();
  });

  test('passes the TTS session section to the chapters indicator', () => {
    render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    fireEvent.click(screen.getByTestId('mini-player'));
    expect(screen.getByTestId('player-sheet').getAttribute('data-active-section')).toBe('2');
  });

  test('borrows the original player in reflow and returns it without remounting the owner', () => {
    const { container } = render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    const host = document.createElement('div');
    host.dataset['testHost'] = 'true';
    document.body.append(host);
    act(() => useTTSPlayerHostStore.getState().setHost('b1', host));
    expect(host.contains(screen.getByTestId('mini-player'))).toBe(true);
    expect(container.querySelector('[data-testid="mini-player"]')).toBeNull();
    fireEvent.click(screen.getByTestId('mini-player'));
    expect(host.contains(screen.getByTestId('player-sheet'))).toBe(true);
    fireEvent.click(screen.getByText('Rate 1.5'));
    fireEvent.click(screen.getByText('Seek 42'));
    expect(ttsState['handleSetRate']).toHaveBeenCalledWith(1.5);
    expect(ttsState['handleSeekTo']).toHaveBeenCalledWith(42);
    act(() => useTTSPlayerHostStore.getState().clearHost('b1', host));
    expect(container.contains(screen.getByTestId('player-sheet'))).toBe(true);
    expect(host.childElementCount).toBe(0);
    fireEvent.click(screen.getByText('Close Player'));
    expect(container.contains(screen.getByTestId('mini-player'))).toBe(true);
  });

  test('a stale host cleanup cannot detach a newer reflow host', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    const store = useTTSPlayerHostStore.getState();
    store.setHost('b1', first);
    store.setHost('b1', second);
    store.clearHost('b1', first);
    expect(useTTSPlayerHostStore.getState().hosts['b1']).toBe(second);
  });

  test('shows the back-to-TTS-location pill when reading has drifted', () => {
    Object.assign(ttsState, { showBackToCurrentTTSLocation: true });
    render(<TTSControl bookKey='b1' gridInsets={gridInsets} />);
    expect(screen.getByText('Back to Read Aloud')).toBeTruthy();
  });
});
