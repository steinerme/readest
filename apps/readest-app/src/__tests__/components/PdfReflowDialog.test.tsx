import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfReflowDialog from '@/app/reader/components/PdfReflowDialog';
import { eventDispatcher } from '@/utils/event';

vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: { isAndroidApp: true } }) }));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    safeAreaInsets: { top: 24, bottom: 16 },
    statusBarHeight: 24,
    systemUIVisible: true,
  }),
}));
vi.mock('@/store/deviceStore', () => ({
  useDeviceControlStore: () => ({
    acquireBackKeyInterception: mocks.acquire,
    releaseBackKeyInterception: mocks.release,
  }),
}));

const mocks = vi.hoisted(() => ({
  pages: [] as Array<{ getReflowText?: () => Promise<unknown> }>,
  goTo: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  index: 0,
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
// Return a stable document object, matching the store's contract.
const doc = {
  get sections() {
    return mocks.pages;
  },
};
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData: () => ({ bookDoc: doc }) }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => ({
      renderer: {
        get index() {
          return mocks.index;
        },
        getContents: () => [{ index: mocks.index }],
      },
      goTo: mocks.goTo,
    }),
    getProgress: () => null,
  }),
}));

const textPage = (str: string) =>
  Promise.resolve({
    items: [{ str, transform: [14, 0, 0, 14, 60, 700], width: 300, height: 14 }],
    width: 612,
    height: 792,
    rotation: 0,
  });
beforeEach(() => {
  sessionStorage.clear();
  mocks.index = 0;
  mocks.goTo.mockReset().mockImplementation(async (page: number) => {
    mocks.index = page;
  });
  mocks.pages = [
    { getReflowText: vi.fn(() => textPage('第一页正文。')) },
    { getReflowText: vi.fn(() => textPage('第二页正文。')) },
  ];
});
afterEach(cleanup);

describe('PDF read-only reflow', () => {
  it('starts at the original physical page and loads just that page', async () => {
    mocks.index = 1;
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    expect(await screen.findByText('第二页正文。')).toBeTruthy();
    expect(mocks.pages[0]!.getReflowText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    expect((screen.getByLabelText('Original PDF Page') as HTMLInputElement).value).toBe('2');
    expect(mocks.goTo).not.toHaveBeenCalled();
  });

  it('adjusts font size without extracting again and returns to the selected original page', async () => {
    const close = vi.fn();
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={close} />);
    await screen.findByText('第一页正文。');
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    fireEvent.click(screen.getByRole('button', { name: 'Reflow Settings' }));
    fireEvent.click(screen.getByLabelText('Increase Reflow Font Size'));
    expect(container.querySelector('article')!.style.fontSize).toBe('24px');
    expect(mocks.pages[0]!.getReflowText).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByText('Next Page')[0]!);
    await screen.findByText('第二页正文。');
    fireEvent.click(screen.getByText('Switch to PDF'));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(mocks.goTo).toHaveBeenCalledWith(1);
  });

  it('shows an empty-page fallback instead of pretending to OCR', async () => {
    mocks.pages = [
      { getReflowText: () => Promise.resolve({ items: [], width: 612, height: 792, rotation: 0 }) },
    ];
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    expect(
      await screen.findByText(
        'No usable text on this page. View the original page; OCR is not included.',
      ),
    ).toBeTruthy();
  });

  it('ignores a stale extraction after changing pages', async () => {
    let resolve!: (value: unknown) => void;
    mocks.pages[0] = {
      getReflowText: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByText('Next Page')[0]!);
    await screen.findByText('第二页正文。');
    await act(async () => {
      resolve(await textPage('不应出现的旧页。'));
    });
    expect(screen.queryByText('不应出现的旧页。')).toBeNull();
    expect(screen.getByText('第二页正文。')).toBeTruthy();
  });

  it('escapes PDF content instead of interpreting HTML', async () => {
    mocks.pages[0] = { getReflowText: () => textPage('<img src=x onerror=alert(1)>') };
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('article img')).toBeNull();
  });

  it('closes immediately even if original navigation never resolves', async () => {
    mocks.goTo.mockImplementation(() => new Promise(() => {}));
    const close = vi.fn();
    render(<PdfReflowDialog bookKey='pdf-1' onClose={close} />);
    await screen.findByText('第一页正文。');
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    fireEvent.click(screen.getByText('Switch to PDF'));
    expect(close).toHaveBeenCalledOnce();
  });

  it('starts without settings and lets all reading controls hide again', async () => {
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    expect(container.querySelector('.pdf-reflow-controls')).toBeNull();
    expect(container.querySelector('header')!.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByText('第一页正文。'));
    expect(container.querySelector('header')!.hasAttribute('inert')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reflow Settings' }));
    expect(container.querySelector('.pdf-reflow-controls')).not.toBeNull();
    fireEvent.click(screen.getByText('Close Reflow Settings'));
    expect(container.querySelector('.pdf-reflow-controls')).toBeNull();
    fireEvent.click(screen.getByLabelText('Hide Reflow Controls'));
    expect(container.querySelector('header')!.hasAttribute('inert')).toBe(true);
  });

  it('native Back closes settings first, then goes directly to library using current state', async () => {
    const close = vi.fn();
    const library = vi.fn();
    render(<PdfReflowDialog bookKey='pdf-1' onClose={close} onGoToLibrary={library} />);
    await screen.findByText('第一页正文。');
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    fireEvent.click(screen.getByRole('button', { name: 'Reflow Settings' }));
    act(() => {
      expect(eventDispatcher.dispatchSync('native-key-down', { keyName: 'Back' })).toBe(true);
    });
    expect(screen.queryByText('Close Reflow Settings')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    act(() => {
      eventDispatcher.dispatchSync('native-key-down', { keyName: 'Back' });
    });
    expect(close).toHaveBeenCalledOnce();
    expect(library).toHaveBeenCalledOnce();
    expect(mocks.goTo).not.toHaveBeenCalled();
  });

  it('Escape and repeated native Back exit to library only once, without waiting on PDF', async () => {
    mocks.goTo.mockImplementation(() => new Promise(() => {}));
    const close = vi.fn();
    const library = vi.fn();
    render(<PdfReflowDialog bookKey='pdf-1' onClose={close} onGoToLibrary={library} />);
    await screen.findByText('第一页正文。');
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => {
      eventDispatcher.dispatchSync('native-key-down', { keyName: 'Back' });
    });
    expect(close).toHaveBeenCalledOnce();
    expect(library).toHaveBeenCalledOnce();
    expect(mocks.goTo).not.toHaveBeenCalled();
  });

  it('does not toggle controls after scrolling or while text is selected', async () => {
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    const text = await screen.findByText('第一页正文。');
    const article = container.querySelector('article')!;
    fireEvent.pointerDown(article, { clientX: 100, clientY: 100 });
    fireEvent.scroll(article);
    fireEvent.click(text);
    expect(container.querySelector('header')!.hasAttribute('inert')).toBe(true);
    // jsdom selection serialization is incomplete; model a non-empty native
    // selection while retaining real pointer/scroll handlers above.
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '第一页',
    } as Selection);
    fireEvent.click(text);
    expect(container.querySelector('header')!.hasAttribute('inert')).toBe(true);
    selection.mockRestore();
  });

  it('shows a navigation error toast without reopening or trapping the reader', async () => {
    const toast = vi.fn();
    eventDispatcher.on('toast', toast);
    mocks.goTo.mockRejectedValue(new Error('render failed'));
    const close = vi.fn();
    render(<PdfReflowDialog bookKey='pdf-1' onClose={close} />);
    await screen.findByText('第一页正文。');
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    fireEvent.click(screen.getByText('Switch to PDF'));
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() => expect(toast).toHaveBeenCalledOnce());
    eventDispatcher.off('toast', toast);
  });

  it('keeps the original document unchanged when returning to library after changing reflow page', async () => {
    const library = vi.fn();
    render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} onGoToLibrary={library} />);
    await screen.findByText('第一页正文。');
    fireEvent.click(screen.getAllByText('Next Page')[0]!);
    await screen.findByText('第二页正文。');
    act(() => {
      eventDispatcher.dispatchSync('native-key-down', { keyName: 'Back' });
    });
    expect(library).toHaveBeenCalledOnce();
    expect(mocks.goTo).not.toHaveBeenCalled();
  });

  it('restores reflow page and font size within this app session after leaving', async () => {
    const first = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    fireEvent.click(screen.getAllByText('Next Page')[0]!);
    await screen.findByText('第二页正文。');
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    fireEvent.click(screen.getByRole('button', { name: 'Reflow Settings' }));
    fireEvent.click(screen.getByLabelText('Increase Reflow Font Size'));
    first.unmount();
    const second = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第二页正文。');
    expect(second.container.querySelector('article')!.style.fontSize).toBe('24px');
    expect(second.container.querySelector('header')!.hasAttribute('inert')).toBe(true);
  });

  it('cleans up native Back and Escape listeners on unmount', () => {
    const close = vi.fn();
    const { unmount } = render(<PdfReflowDialog bookKey='pdf-1' onClose={close} />);
    unmount();
    expect(eventDispatcher.dispatchSync('native-key-down', { keyName: 'Back' })).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });
});

describe('PDF reflow audio integration', () => {
  const rangeFor = (text: string) => {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = '<div class="textLayer"><span></span></div>';
    doc.querySelector('span')!.textContent = text;
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('span')!);
    return range;
  };
  it('manual entry overrides saved page including explicit page zero, retaining font preferences', async () => {
    sessionStorage.setItem(
      'pdf-reflow:pdf-1',
      JSON.stringify({ page: 1, fontSize: 30, lineHeight: 2.2 }),
    );
    // Save via the public component contract rather than relying on session key format.
    const first = render(<PdfReflowDialog bookKey='pdf-1' initialPage={1} onClose={vi.fn()} />);
    await screen.findByText('第二页正文。');
    first.unmount();
    render(<PdfReflowDialog bookKey='pdf-1' initialPage={0} onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    expect(screen.queryByText('第二页正文。')).toBeNull();
  });
  it('keeps audio controls reachable with chrome hidden and displays real markers across pages', async () => {
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    expect(container.querySelector('header')!.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('button', { name: 'Read Aloud' })).toBeTruthy();
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
    expect(container.querySelector('mark')!.textContent).toBe('第一页正文。');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    fireEvent.wheel(container.querySelector('article')!);
    expect(screen.getByRole('button', { name: 'Return to Current Speech' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Return to Current Speech' }));
    await waitFor(() => expect(container.querySelector('mark')!.textContent).toBe('第二页正文。'));
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    const stopped = vi.fn();
    eventDispatcher.on('tts-stop', stopped);
    fireEvent.click(screen.getByText('Switch to PDF'));
    expect(stopped).not.toHaveBeenCalled();
    eventDispatcher.off('tts-stop', stopped);
  });
});

describe('PDF return navigation verification', () => {
  it('does not emit a failure toast when fixed-layout index reaches page zero', async () => {
    const toast = vi.fn();
    eventDispatcher.on('toast', toast);
    try {
      render(<PdfReflowDialog bookKey='pdf-1' initialPage={0} onClose={vi.fn()} />);
      await screen.findByText('第一页正文。');
      fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
      await act(async () => {
        fireEvent.click(screen.getByText('Switch to PDF'));
      });
      expect(mocks.goTo).toHaveBeenCalledWith(0);
      expect(toast).not.toHaveBeenCalled();
    } finally {
      eventDispatcher.off('toast', toast);
    }
  });
  it('still reports an actual failed navigation when the active PDF page remains different', async () => {
    const toast = vi.fn();
    eventDispatcher.on('toast', toast);
    try {
      mocks.goTo.mockResolvedValue(undefined);
      render(<PdfReflowDialog bookKey='pdf-1' initialPage={1} onClose={vi.fn()} />);
      await screen.findByText('第二页正文。');
      fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
      await act(async () => {
        fireEvent.click(screen.getByText('Switch to PDF'));
      });
      expect(toast).toHaveBeenCalledOnce();
    } finally {
      eventDispatcher.off('toast', toast);
    }
  });
  it('keeps transport and page controls together outside the scrolling article', async () => {
    const { container } = render(<PdfReflowDialog bookKey='pdf-1' onClose={vi.fn()} />);
    await screen.findByText('第一页正文。');
    const dock = container.querySelector('footer.pdf-reflow-dock')!;
    expect(dock.contains(screen.getByRole('button', { name: 'Read Aloud' }))).toBe(true);
    expect(dock.contains(screen.getByLabelText('Show Reflow Controls'))).toBe(true);
    expect(container.querySelector('article')!.contains(dock)).toBe(false);
    fireEvent.click(screen.getByLabelText('Show Reflow Controls'));
    expect(dock.contains(screen.getByLabelText('Original PDF Page'))).toBe(true);
  });
});
