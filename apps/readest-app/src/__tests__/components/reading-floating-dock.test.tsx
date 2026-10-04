import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: CustomEvent) => void>>();
  const state = {
    hoveredBookKey: null as string | null,
    viewStates: {} as Record<
      string,
      { ttsEnabled?: boolean; inited?: boolean; previewMode?: boolean }
    >,
    sideBar: { isSideBarVisible: false, isSideBarPinned: false },
    notebook: { isNotebookVisible: false, isNotebookPinned: false },
    settingsOpen: false,
    reflow: {} as Record<string, { page: number }>,
    progress: null as null | {
      location: string;
      sectionLabel?: string;
      page?: number;
      fraction?: number;
    },
  };
  const dispatch = vi.fn(async (name: string, detail: unknown) => {
    handlers.get(name)?.forEach((fn) => fn({ detail } as CustomEvent));
  });
  const selectorStore = <T extends object>(get: () => T) =>
    Object.assign((selector: (s: T) => unknown) => selector(get()), { getState: get });
  return { handlers, state, dispatch, selectorStore };
});
vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    dispatch: h.dispatch,
    on: (name: string, fn: (e: CustomEvent) => void) => {
      if (!h.handlers.has(name)) h.handlers.set(name, new Set());
      h.handlers.get(name)!.add(fn);
    },
    off: (name: string, fn: (e: CustomEvent) => void) => h.handlers.get(name)?.delete(fn),
  },
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: h.selectorStore(() => ({
    hoveredBookKey: h.state.hoveredBookKey,
    viewStates: h.state.viewStates,
  })),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: h.selectorStore(() => h.state.sideBar),
}));
vi.mock('@/store/notebookStore', () => ({
  useNotebookStore: h.selectorStore(() => h.state.notebook),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: h.selectorStore(() => ({ isSettingsDialogOpen: h.state.settingsOpen })),
}));
vi.mock('@/store/pdfReflowStore', () => ({
  usePdfReflowStore: h.selectorStore(() => ({ sessions: h.state.reflow })),
}));
vi.mock('@/store/readerProgressStore', () => ({ useBookProgress: () => h.state.progress }));

import ReadingFloatingDock from '@/app/reader/components/ai/ReadingFloatingDock';
import ReadingResumeCard from '@/app/reader/components/ai/ReadingResumeCard';
import { writeResume, releaseOpenedResume, readResume } from '@/services/ai/readingResume';

class Observer {
  observe() {}
  disconnect() {}
}
const cell = (children: React.ReactNode) => <div data-view-transition-root=''>{children}</div>;
const dock = () => document.querySelector('[data-reading-dock]') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', Observer);
  h.handlers.clear();
  h.state.hoveredBookKey = null;
  h.state.viewStates = { 'b-1': { ttsEnabled: false, inited: true } };
  h.state.sideBar = { isSideBarVisible: false, isSideBarPinned: false };
  h.state.notebook = { isNotebookVisible: false, isNotebookPinned: false };
  h.state.settingsOpen = false;
  h.state.reflow = {};
  h.state.progress = null;
  localStorage.clear();
  releaseOpenedResume('b-1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('floating listen + AI buttons', () => {
  it('shows two round buttons on a plain reading page', () => {
    render(cell(<ReadingFloatingDock bookKey='b-1' bottomInset={16} />));
    expect(dock().dataset['readingDock']).toBe('visible');
    expect(screen.getByRole('button', { name: '听书' }).className).toContain('rounded-full');
    expect(screen.getByRole('button', { name: '问这本书' }).className).toContain('rounded-full');
    expect(dock().style.bottom).toBe('40px');
  });
  it.each([
    ['tap-to-show header/footer bars', () => (h.state.hoveredBookKey = 'b-1')],
    [
      'an unpinned sidebar',
      () => (h.state.sideBar = { isSideBarVisible: true, isSideBarPinned: false }),
    ],
    [
      'an unpinned notebook',
      () => (h.state.notebook = { isNotebookVisible: true, isNotebookPinned: false }),
    ],
    ['the settings dialog', () => (h.state.settingsOpen = true)],
  ])('is removed from view and touch while %s are open', (_name, open) => {
    open();
    render(cell(<ReadingFloatingDock bookKey='b-1' />));
    expect(dock().dataset['readingDock']).toBe('hidden');
    expect(dock().getAttribute('aria-hidden')).toBe('true');
    expect(dock().hasAttribute('inert')).toBe(true);
    expect(dock().className).toContain('opacity-0');
  });
  it("stays out of the way of another book's bars and pinned side panels", () => {
    h.state.hoveredBookKey = 'other-2';
    h.state.sideBar = { isSideBarVisible: true, isSideBarPinned: true };
    h.state.notebook = { isNotebookVisible: true, isNotebookPinned: true };
    render(cell(<ReadingFloatingDock bookKey='b-1' />));
    expect(dock().dataset['readingDock']).toBe('visible');
  });
  it('hides for any sheet, dialog or popup that marks itself as an overlay, and comes back', async () => {
    render(cell(<ReadingFloatingDock bookKey='b-1' />));
    expect(dock().dataset['readingDock']).toBe('visible');
    const sheet = document.createElement('div');
    sheet.setAttribute('data-capture-blocking-overlay', 'true');
    await act(async () => {
      document.body.appendChild(sheet);
    });
    await waitFor(() => expect(dock().dataset['readingDock']).toBe('hidden'));
    await act(async () => {
      sheet.remove();
    });
    await waitFor(() => expect(dock().dataset['readingDock']).toBe('visible'));
  });
  it('hides when a sheet was already open before mounting', () => {
    const sheet = document.createElement('div');
    sheet.setAttribute('data-capture-blocking-overlay', 'true');
    document.body.appendChild(sheet);
    render(cell(<ReadingFloatingDock bookKey='b-1' />));
    expect(dock().dataset['readingDock']).toBe('hidden');
  });
  it('starts listening from the current spot, then toggles pause / resume without turning pages', () => {
    const turn = vi.fn();
    const { rerender } = render(
      <div onClick={turn}>{cell(<ReadingFloatingDock bookKey='b-1' />)}</div>,
    );
    fireEvent.click(screen.getByRole('button', { name: '听书' }));
    expect(turn).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledWith('tts-speak', { bookKey: 'b-1' });
    h.state.viewStates['b-1']!.ttsEnabled = true;
    rerender(<div onClick={turn}>{cell(<ReadingFloatingDock bookKey='b-1' />)}</div>);
    act(() => {
      h.handlers
        .get('tts-playback-state')
        ?.forEach((fn) => fn({ detail: { bookKey: 'b-1', state: 'playing' } } as CustomEvent));
    });
    expect(screen.getByRole('button', { name: '暂停朗读' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '暂停朗读' }));
    expect(h.dispatch).toHaveBeenCalledWith('tts-toggle-play', { bookKey: 'b-1' });
    act(() => {
      h.handlers
        .get('tts-playback-state')
        ?.forEach((fn) => fn({ detail: { bookKey: 'b-1', state: 'paused' } } as CustomEvent));
    });
    expect(screen.getByRole('button', { name: '继续朗读' })).toBeTruthy();
    // another book's playback never changes this book's button
    act(() => {
      h.handlers
        .get('tts-playback-state')
        ?.forEach((fn) => fn({ detail: { bookKey: 'zzz-9', state: 'playing' } } as CustomEvent));
    });
    expect(screen.getByRole('button', { name: '继续朗读' })).toBeTruthy();
  });
  it('starts a reflowed PDF from the reflow page, not the saved PDF location', () => {
    h.state.reflow = { 'b-1': { page: 7 } };
    render(cell(<ReadingFloatingDock bookKey='b-1' />));
    fireEvent.click(screen.getByRole('button', { name: '听书' }));
    expect(h.dispatch).toHaveBeenCalledWith('tts-speak', { bookKey: 'b-1', index: 7 });
  });
  it('opens the assistant for this book without turning a page', () => {
    const turn = vi.fn();
    render(<div onClick={turn}>{cell(<ReadingFloatingDock bookKey='b-1' />)}</div>);
    fireEvent.click(screen.getByRole('button', { name: '问这本书' }));
    expect(turn).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledWith('reading-ai-open', { bookKey: 'b-1', mode: 'book' });
  });
  it('lifts above a visible listening mini player', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.hasAttribute('data-view-transition-root') ? 0 : 700;
      return {
        top,
        bottom: 915,
        height: 915 - top,
        width: 412,
        left: 0,
        right: 412,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    });
    try {
      render(
        cell(
          <>
            <div data-reading-tts-player='visible' />
            <ReadingFloatingDock bookKey='b-1' />
          </>,
        ),
      );
      expect(dock().style.bottom).toBe('231px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

describe('welcome-back card', () => {
  const away = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const point = { at: away, cfi: 'epubcfi(/6/8)', label: '第三章', page: 42, fraction: 0.37 };
  it('shows where you stopped after a long break and opens a recap on request', () => {
    writeResume('b', point);
    render(cell(<ReadingResumeCard bookKey='b-1' />));
    const card = document.querySelector('[data-reading-resume]')!;
    expect(card.textContent).toContain('第三章');
    expect(card.textContent).toContain('第 42 页');
    expect(card.textContent).toContain('3 天前');
    fireEvent.click(screen.getByText('前情提要'));
    expect(h.dispatch).toHaveBeenCalledWith('reading-ai-open', { bookKey: 'b-1', mode: 'recap' });
    expect(document.querySelector('[data-reading-resume]')).toBeNull();
  });
  it('can be dismissed, and does not ask the AI anything by itself', () => {
    writeResume('b', point);
    render(cell(<ReadingResumeCard bookKey='b-1' />));
    fireEvent.click(screen.getByText('知道了'));
    expect(document.querySelector('[data-reading-resume]')).toBeNull();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('stays quiet after a short break, for a first-time book, or in preview mode', () => {
    writeResume('b', { ...point, at: Date.now() - 60 * 60 * 1000 });
    render(cell(<ReadingResumeCard bookKey='b-1' />));
    expect(document.querySelector('[data-reading-resume]')).toBeNull();
    cleanup();
    releaseOpenedResume('b-1');
    localStorage.clear();
    render(cell(<ReadingResumeCard bookKey='b-1' />));
    expect(document.querySelector('[data-reading-resume]')).toBeNull();
  });
  it('hides while bars or sheets are open and when the reader moves on', () => {
    writeResume('b', point);
    h.state.progress = { location: 'epubcfi(/6/8)' };
    const { rerender } = render(cell(<ReadingResumeCard bookKey='b-1' />));
    expect(document.querySelector('[data-reading-resume]')).not.toBeNull();
    h.state.hoveredBookKey = 'b-1';
    rerender(cell(<ReadingResumeCard bookKey='b-1' />));
    expect(document.querySelector('[data-reading-resume]')).toBeNull();
    h.state.hoveredBookKey = null;
    rerender(cell(<ReadingResumeCard bookKey='b-1' />));
    expect(document.querySelector('[data-reading-resume]')).not.toBeNull();
    h.state.progress = { location: 'epubcfi(/6/10)' };
    rerender(cell(<ReadingResumeCard bookKey='b-1' />));
    expect(document.querySelector('[data-reading-resume]')).toBeNull();
  });
  it('does not render before the book is ready', () => {
    writeResume('b', point);
    h.state.viewStates['b-1']!.inited = false;
    render(cell(<ReadingResumeCard bookKey='b-1' />));
    expect(document.querySelector('[data-reading-resume]')).toBeNull();
  });
  it('records the current spot for next time, but not while previewing a deep link', () => {
    vi.useFakeTimers();
    try {
      h.state.progress = {
        location: 'epubcfi(/6/20)',
        sectionLabel: '第五章',
        page: 77,
        fraction: 0.5,
      };
      const { unmount } = render(cell(<ReadingResumeCard bookKey='b-1' />));
      unmount();
      expect(readResume('b')).toMatchObject({
        cfi: 'epubcfi(/6/20)',
        label: '第五章',
        page: 77,
        fraction: 0.5,
      });
      localStorage.clear();
      releaseOpenedResume('b-1');
      h.state.viewStates['b-1']!.previewMode = true;
      const preview = render(cell(<ReadingResumeCard bookKey='b-1' />));
      preview.unmount();
      expect(readResume('b')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses the reflow page number when reading a reflowed PDF', () => {
    h.state.reflow = { 'b-1': { page: 11 } };
    h.state.progress = { location: 'pdf-cfi', page: 3, sectionLabel: '' };
    const { unmount } = render(cell(<ReadingResumeCard bookKey='b-1' />));
    unmount();
    expect(readResume('b')?.page).toBe(12);
  });
});
