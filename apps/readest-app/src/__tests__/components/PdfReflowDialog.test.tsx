import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfReflowDialog from '@/app/reader/components/PdfReflowDialog';
import { eventDispatcher } from '@/utils/event';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { useTTSPlayerHostStore } from '@/store/ttsPlayerHostStore';

const mocks = vi.hoisted(() => ({
  pages: [] as Array<{ getReflowText?: () => Promise<unknown> }>,
  index: 0,
  goTo: vi.fn(),
  hovered: '',
  setHovered: vi.fn(),
  settings: { defaultFontSize: 18, lineHeight: 1.85, marginLeftPx: 24 },
  originalDoc: null as Document | null,
  notes: [] as import('@/types/book').BookNote[],
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: { isMobile: true } }) }));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    safeAreaInsets: { top: 24, bottom: 16 },
    statusBarHeight: 24,
    systemUIVisible: true,
  }),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: { globalReadSettings: {} } }),
}));
const doc = {
  get sections() {
    return mocks.pages;
  },
};
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ bookDoc: doc }),
    getConfig: () => ({ booknotes: mocks.notes }),
  }),
}));
const view = Object.assign(new EventTarget(), {
  renderer: {
    get index() {
      return mocks.index;
    },
    getContents: () => [{ index: mocks.index, doc: mocks.originalDoc }],
  },
  goTo: (page: number) => mocks.goTo(page),
  resolveNavigation: (target: string) => ({ index: Number(target) }),
  getCFI: (index: number, range: Range) => `original-${index}-${range.startOffset}`,
  resolveCFI: () => ({
    index: 0,
    anchor: (doc: Document) => {
      const range = doc.createRange();
      range.selectNodeContents(doc.querySelector('span')!);
      return range;
    },
  }),
});
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => view,
    getProgress: () => null,
    getViewSettings: () => mocks.settings,
    hoveredBookKey: mocks.hovered,
    setHoveredBookKey: mocks.setHovered,
  }),
}));
const textPage = (str: string) =>
  Promise.resolve({
    items: [{ str, transform: [14, 0, 0, 14, 60, 700], width: 300, height: 14 }],
    width: 612,
    height: 792,
    rotation: 0,
  });
const rangeFor = (text: string) => {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = '<div class="textLayer"><span></span></div>';
  doc.querySelector('span')!.textContent = text;
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('span')!);
  return range;
};
beforeEach(() => {
  sessionStorage.clear();
  mocks.index = 0;
  mocks.hovered = '';
  mocks.setHovered.mockReset();
  mocks.originalDoc = null;
  mocks.notes = [];
  mocks.settings = { defaultFontSize: 18, lineHeight: 1.85, marginLeftPx: 24 };
  mocks.goTo.mockReset().mockImplementation(async (page: number) => {
    mocks.index = page;
    view.dispatchEvent(new CustomEvent('relocate'));
  });
  mocks.pages = [
    { getReflowText: vi.fn(() => textPage('第一页正文。')) },
    { getReflowText: vi.fn(() => textPage('第二页正文。')) },
  ];
});
afterEach(() => {
  cleanup();
  usePdfReflowStore.setState({ sessions: {} });
});

describe('PDF reflow as the original reader content mode', () => {
  it('reports selected text through shared annotation service with the original range', async () => {
    mocks.originalDoc = rangeFor('第一页正文。').startContainer.ownerDocument;
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    const p = await screen.findByText('第一页正文。');
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const report = vi.fn();
    eventDispatcher.on('footnote-selection', report);
    try {
      fireEvent(document, new Event('selectionchange'));
      await waitFor(() => expect(report).toHaveBeenCalled());
      expect(report.mock.calls[0]![0].detail).toMatchObject({
        key: 'pdf-1',
        index: 0,
        reflow: true,
      });
      expect(report.mock.calls[0]![0].detail.originalRange.startContainer.ownerDocument).toBe(
        mocks.originalDoc,
      );
    } finally {
      eventDispatcher.off('footnote-selection', report);
      window.getSelection()!.removeAllRanges();
    }
  });
  it('projects the same stored original annotations and updates after deletion', async () => {
    mocks.originalDoc = rangeFor('第一页正文。').startContainer.ownerDocument;
    mocks.notes = [
      {
        id: 'note1',
        type: 'annotation',
        cfi: 'original-0-0',
        text: '第一页正文。',
        style: 'highlight',
        color: '#ffcc00',
        note: '',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const r = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    expect(r.container.querySelector('[data-reflow-annotation]')).toBeTruthy();
    mocks.notes = [];
    r.rerender(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    expect(r.container.querySelector('[data-reflow-annotation]')).toBeNull();
  });
  it('uses the physical page and does not mount another header/footer or modal', async () => {
    mocks.index = 1;
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第二页正文。');
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('footer')).toBeNull();
    expect(container.querySelector('[aria-modal]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Read Aloud' })).toBeNull();
    expect(usePdfReflowStore.getState().sessions['pdf-1']?.page).toBe(1);
  });
  it('taps reveal the original shared chrome while scrolling/selection never toggle it', async () => {
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    const text = await screen.findByText('第一页正文。');
    fireEvent.click(text);
    expect(mocks.setHovered).toHaveBeenCalledWith('pdf-1');
    mocks.setHovered.mockClear();
    fireEvent.pointerDown(container.querySelector('article')!, { clientX: 100, clientY: 100 });
    fireEvent.scroll(container.querySelector('article')!);
    fireEvent.click(text);
    expect(mocks.setHovered).not.toHaveBeenCalled();
  });
  it('reads the exact same font/line-spacing settings updated by the original panels', async () => {
    const r = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    expect(r.container.querySelector('article')!.style.fontSize).toBe('22.5px');
    mocks.settings.defaultFontSize = 24;
    mocks.settings.lineHeight = 2.2;
    r.rerender(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    expect(r.container.querySelector('article')!.style.fontSize).toBe('30px');
    expect(r.container.querySelector('article')!.style.lineHeight).toBe('2.2');
    expect(mocks.pages[0]!.getReflowText).toHaveBeenCalledTimes(1);
  });
  it('manual page navigation moves the original location for bookmarks and other services', async () => {
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    fireEvent.click(screen.getByText('Next Page'));
    await screen.findByText('第二页正文。');
    expect(mocks.goTo).toHaveBeenCalledWith(1);
    expect(usePdfReflowStore.getState().sessions['pdf-1']?.page).toBe(1);
  });
  it('original TOC/search/history relocations update visible reflow content', async () => {
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    await act(async () => {
      await view.goTo(1);
    });
    await screen.findByText('第二页正文。');
  });
  it('explicit page zero overrides saved page', async () => {
    const r = render(<PdfReflowDialog bookKey='pdf-1' initialPage={1} onClose={vi.fn()} />);
    await screen.findByText('第二页正文。');
    r.unmount();
    render(<PdfReflowDialog bookKey='pdf-1' initialPage={0} onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
  });
  it('starts read-aloud through the original session with the exact current physical page', async () => {
    const speak = vi.fn();
    eventDispatcher.on('tts-speak', speak);
    try {
      render(<PdfReflowDialog bookKey='pdf-1' initialPage={1} onClose={vi.fn()} />);
      await screen.findByText('第二页正文。');
      await act(async () => {
        await usePdfReflowStore.getState().sessions['pdf-1']!.speak();
      });
      expect(speak).toHaveBeenCalledWith(
        expect.objectContaining({ detail: { bookKey: 'pdf-1', index: 1 } }),
      );
    } finally {
      eventDispatcher.off('tts-speak', speak);
    }
  });
  it('ignores stale extraction after rapid navigation', async () => {
    let resolve!: (value: unknown) => void;
    mocks.pages[0] = {
      getReflowText: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Next Page'));
    await screen.findByText('第二页正文。');
    await act(async () => {
      resolve(await textPage('旧页不能出现'));
    });
    expect(screen.queryByText('旧页不能出现')).toBeNull();
  });
  it('escapes PDF content and provides empty-page fallback without OCR', async () => {
    mocks.pages[0] = { getReflowText: () => textPage('<img src=x onerror=alert(1)>') };
    const r = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(r.container.querySelector('article img')).toBeNull();
    r.unmount();
    mocks.pages[0] = {
      getReflowText: () => Promise.resolve({ items: [], width: 612, height: 792, rotation: 0 }),
    };
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText(
      'No usable text on this page. View the original page; OCR is not included.',
    );
  });
  it('switching back closes immediately, verifies true original page, and never stops audio', async () => {
    const close = vi.fn(),
      stopped = vi.fn(),
      toast = vi.fn();
    eventDispatcher.on('tts-stop', stopped);
    eventDispatcher.on('toast', toast);
    try {
      render(<PdfReflowDialog bookKey='pdf-1' onClose={close} />);
      await screen.findByText('第一页正文。');
      await act(async () => {
        usePdfReflowStore.getState().sessions['pdf-1']!.close();
      });
      expect(close).toHaveBeenCalledOnce();
      expect(stopped).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
    } finally {
      eventDispatcher.off('tts-stop', stopped);
      eventDispatcher.off('toast', toast);
    }
  });
  it('a stalled PDF cannot block the switch back to original', async () => {
    const close = vi.fn();
    render(<PdfReflowDialog bookKey='pdf-1' onClose={close} />);
    await screen.findByText('第一页正文。');
    mocks.goTo.mockImplementation(() => new Promise(() => {}));
    act(() => usePdfReflowStore.getState().sessions['pdf-1']!.close());
    expect(close).toHaveBeenCalledOnce();
  });
  it('actual wrong original page still reports navigation failure', async () => {
    const toast = vi.fn();
    eventDispatcher.on('toast', toast);
    try {
      render(<PdfReflowDialog bookKey='pdf-1' initialPage={1} onClose={vi.fn()} />);
      await screen.findByText('第二页正文。');
      mocks.index = 0;
      mocks.goTo.mockResolvedValue(undefined);
      await act(async () => {
        usePdfReflowStore.getState().sessions['pdf-1']!.close();
      });
      await waitFor(() => expect(toast).toHaveBeenCalledOnce());
    } finally {
      eventDispatcher.off('toast', toast);
    }
  });
  it('follows actual spoken ranges and manual wheel detaches only visual following', async () => {
    const r = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    await act(async () => {
      await eventDispatcher.dispatch('tts-playback-state', { bookKey: 'pdf-1', state: 'playing' });
      await eventDispatcher.dispatch('tts-position', {
        bookKey: 'pdf-1',
        sectionIndex: 0,
        sequence: 1,
        kind: 'sentence',
        range: rangeFor('第一页正文。'),
      });
    });
    expect(r.container.querySelector('mark')!.textContent).toBe('第一页正文。');
    fireEvent.wheel(r.container.querySelector('article')!);
    expect(screen.getByText('Back to Read Aloud')).toBeTruthy();
    await act(async () => {
      await eventDispatcher.dispatch('tts-position', {
        bookKey: 'pdf-1',
        sectionIndex: 1,
        sequence: 2,
        kind: 'sentence',
        range: rangeFor('第二页正文。'),
      });
    });
    expect(screen.queryByText('第二页正文。')).toBeNull();
    fireEvent.click(screen.getByText('Back to Read Aloud'));
    await waitFor(() =>
      expect(r.container.querySelector('mark')!.textContent).toBe('第二页正文。'),
    );
  });
  it('unmount releases only visual host/navigation and leaves original session ownership alone', async () => {
    const stopped = vi.fn();
    eventDispatcher.on('tts-stop', stopped);
    try {
      const r = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
      await screen.findByText('第一页正文。');
      expect(useTTSPlayerHostStore.getState().hosts['pdf-1']).toBeTruthy();
      r.unmount();
      expect(useTTSPlayerHostStore.getState().hosts['pdf-1']).toBeUndefined();
      expect(usePdfReflowStore.getState().sessions['pdf-1']).toBeUndefined();
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      eventDispatcher.off('tts-stop', stopped);
    }
  });
});
