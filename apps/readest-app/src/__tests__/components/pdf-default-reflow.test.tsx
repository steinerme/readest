import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HeaderBar from '@/app/reader/components/HeaderBar';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { useLayoutEffect } from 'react';

let ready = false;
let format = 'PDF';
let page = 4;
let loaded = true;
const view = {
  renderer: {
    getContents: () => [],
    get index() {
      return page;
    },
  },
};
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobile: true } }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: { globalReadSettings: { highlightStyle: 'highlight', highlightStyles: {} } },
  }),
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ isDarkMode: false, systemUIVisible: true, statusBarHeight: 0 }),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ isSideBarVisible: false, getIsSideBarVisible: () => false }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      viewStates: { 'book-1': { inited: ready } },
      bookKeys: ['book-1'],
      hoveredBookKey: 'book-1',
      getView: () => view,
      getViewSettings: () => ({ enableAnnotationQuickActions: false }),
      setHoveredBookKey: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ book: { format }, bookDoc: loaded ? { sections: [1, 2, 3] } : null }),
    getConfig: () => null,
  }),
}));
vi.mock('@/store/trafficLightStore', () => ({
  useTrafficLightStore: () => ({
    trafficLightInFullscreen: false,
    setTrafficLightVisibility: vi.fn(),
  }),
}));
vi.mock('@/hooks/useTrafficLight', () => ({
  useTrafficLight: () => ({ isTrafficLightVisible: false }),
}));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (n: number) => n }));
vi.mock('@/app/reader/hooks/useSpatialNavigation', () => ({ useSpatialNavigation: () => {} }));
vi.mock('@/utils/insets', () => ({ getHeaderTriggerHeight: () => 0 }));
vi.mock('@/helpers/settings', () => ({ saveViewSettings: vi.fn() }));
vi.mock('@/app/reader/components/SidebarToggler', () => ({ default: () => null }));
vi.mock('@/app/reader/components/BookmarkToggler', () => ({ default: () => null }));
vi.mock('@/app/reader/components/NotebookToggler', () => ({ default: () => null }));
vi.mock('@/app/reader/components/TranslationToggler', () => ({ default: () => null }));
vi.mock('@/app/reader/components/ViewMenu', () => ({ default: () => null }));
vi.mock('@/app/reader/components/SyncInfoDialog', () => ({ default: () => null }));
vi.mock('@/components/WindowButtons', () => ({ default: () => null }));
vi.mock('@/components/Dropdown', () => ({ default: () => null }));
vi.mock('@/components/ModalPortal', () => ({
  default: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}));
vi.mock('@/app/reader/components/PdfReflowDialog', () => ({
  default: ({ initialPage, onClose }: { initialPage?: number; onClose: () => void }) => {
    useLayoutEffect(() => {
      const navigate = async () => {};
      const store = usePdfReflowStore.getState();
      store.setSession('book-1', {
        page: initialPage ?? 0,
        count: 3,
        close: onClose,
        navigate,
        speak: async () => {},
        returnToSpeech: () => {},
      });
      return () => store.clearSession('book-1', navigate);
    }, []);
    return <div data-testid='reflow' data-page={initialPage ?? 'saved'} />;
  },
}));
const props = {
  bookKey: 'book-1',
  bookTitle: 'PDF',
  isTopLeft: true,
  isHoveredAnim: false,
  gridInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  screenInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  onCloseBook: vi.fn(),
  onGoToLibrary: vi.fn(),
};
beforeEach(() => {
  ready = false;
  format = 'PDF';
  loaded = true;
  page = 4;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  usePdfReflowStore.setState({ sessions: {} });
  vi.unstubAllGlobals();
});
describe('PDF default reflow', () => {
  it('waits for restored original view and document before default opening', () => {
    const r = render(<HeaderBar {...props} />);
    expect(screen.queryByTestId('reflow')).toBeNull();
    ready = true;
    loaded = false;
    r.rerender(<HeaderBar {...props} />);
    expect(screen.queryByTestId('reflow')).toBeNull();
    loaded = true;
    r.rerender(<HeaderBar {...props} />);
    expect(screen.getByTestId('reflow').getAttribute('data-page')).toBe('saved');
  });
  it('does not reopen after choosing original, but direct toolbar switch uses current original page', () => {
    ready = true;
    const r = render(<HeaderBar {...props} />);
    fireEvent.click(screen.getByText('Switch to PDF'));
    r.rerender(<HeaderBar {...props} />);
    expect(screen.queryByTestId('reflow')).toBeNull();
    page = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Reflow' }));
    expect(screen.getByTestId('reflow').getAttribute('data-page')).toBe('0');
  });
  it('does not change EPUB startup or show a PDF toggle', () => {
    ready = true;
    format = 'EPUB';
    render(<HeaderBar {...props} />);
    expect(screen.queryByTestId('reflow')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch to Reflow' })).toBeNull();
  });
  it('defaults to reflow on a fresh reader mount', () => {
    ready = true;
    const r = render(<HeaderBar {...props} />);
    fireEvent.click(screen.getByText('Switch to PDF'));
    r.unmount();
    render(<HeaderBar {...props} />);
    expect(screen.getByTestId('reflow')).toBeTruthy();
  });
});
