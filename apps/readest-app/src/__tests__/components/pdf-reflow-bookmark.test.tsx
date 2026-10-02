import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
const h = vi.hoisted(() => ({ notes: [] as any[], save: vi.fn(), ribbon: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: () => ({ settings: {} }) }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (n: number) => n }));
const config = {
  get booknotes() {
    return h.notes;
  },
};
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => config,
    saveConfig: h.save,
    getBookData: () => ({ book: { format: 'PDF' } }),
    updateBooknotes: (_key: string, notes: any[]) => {
      h.notes = notes;
      return config;
    },
  }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getProgress: () => ({ location: 'epubcfi(/6/2!)', page: 1 }),
    getView: () => ({ getCFI: (page: number) => `epubcfi(/6/${2 * (page + 1)}!)` }),
    getViewState: () => ({ ribbonVisible: false }),
    setBookmarkRibbonVisibility: h.ribbon,
  }),
}));
import BookmarkToggler from '@/app/reader/components/BookmarkToggler';
afterEach(() => {
  cleanup();
  usePdfReflowStore.setState({ sessions: {} });
  h.notes = [];
  vi.clearAllMocks();
});
describe('one bookmark service for original PDF and reflow', () => {
  it('bookmarks the visible reflow page even when sound has moved the hidden original', () => {
    usePdfReflowStore
      .getState()
      .setSession('b1', {
        page: 44,
        count: 307,
        navigate: async () => {},
        close: vi.fn(),
        speak: async () => {},
        returnToSpeech: vi.fn(),
      });
    render(<BookmarkToggler bookKey='b1' />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Bookmark' }));
    expect(h.notes[0]).toMatchObject({ type: 'bookmark', cfi: 'epubcfi(/6/90!)', page: 45 });
    expect(h.save).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bookmark' }));
    expect(h.notes[0].deletedAt).toBeTypeOf('number');
  });
});
