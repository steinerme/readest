import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTTSPlayerHostStore } from '@/store/ttsPlayerHostStore';
import { useThemeStore } from '@/store/themeStore';
import { eventDispatcher } from '@/utils/event';
import { useReflowNavigation } from '../hooks/useReflowNavigation';
import { usePdfReflowTTS } from '../hooks/usePdfReflowTTS';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { reflowPdfText, type ReflowPage } from '@/utils/pdfReflow';
import '@/styles/pdf-reflow.css';
import { readReflowSession, writeReflowSession } from '@/utils/pdfReflowSession';
import { getPdfRendererPage, isPdfPageVisible } from '@/utils/pdfRendererPage';

interface Props {
  bookKey: string;
  /** Manual original→reflow entry overrides the saved page. Default opening
   * leaves this undefined to restore the previous reflow session. */
  initialPage?: number;
  onClose: () => void;
  onGoToLibrary?: () => void;
}

/** Intentionally read-only, page-based reflow. Never creates synthetic CFIs or
 * writes annotations/positions into the original document while reading text. */
const PdfReflowDialog = ({ bookKey, initialPage, onClose, onGoToLibrary }: Props) => {
  const _ = useTranslation();
  const { safeAreaInsets, statusBarHeight, systemUIVisible } = useThemeStore();
  const [chromeVisible, setChromeVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = playerHostRef.current;
    if (!host) return;
    const store = useTTSPlayerHostStore.getState();
    store.setHost(bookKey, host);
    return () => store.clearHost(bookKey, host);
  }, [bookKey]);
  const exiting = useRef(false);
  const pointer = useRef<{
    x: number;
    y: number;
    time: number;
    moved: boolean;
    down: boolean;
  } | null>(null);
  const { getBookData } = useBookDataStore();
  const { getView, getProgress } = useReaderStore();
  const bookDoc = getBookData(bookKey)?.bookDoc;
  const count = bookDoc?.sections.length ?? 0;
  const [saved] = useState(() => readReflowSession(bookKey, count));
  const [page, setPage] = useState(() => {
    if (initialPage !== undefined && Number.isInteger(initialPage))
      return Math.max(0, Math.min(count - 1, initialPage));
    if (saved) return saved.page;
    const index =
      getPdfRendererPage(getView(bookKey)?.renderer) ?? getProgress(bookKey)?.section.current ?? 0;
    return Math.max(0, Math.min(count - 1, Number.isFinite(index) ? index : 0));
  });
  const [pageInput, setPageInput] = useState(String(page + 1));
  const [fontSize, setFontSize] = useState(saved?.fontSize ?? 22);
  const [lineHeight, setLineHeight] = useState(saved?.lineHeight ?? 1.85);
  useEffect(() => {
    writeReflowSession(bookKey, { page, fontSize, lineHeight });
  }, [bookKey, page, fontSize, lineHeight]);
  const [result, setResult] = useState<ReflowPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);

  const scrollRef = useRef<HTMLElement>(null);
  const cacheRef = useRef(new Map<number, ReflowPage>());
  const tts = usePdfReflowTTS({ bookKey, page, count, result, setPage, scrollRef });

  useEffect(() => {
    cacheRef.current.clear();
  }, [bookKey, bookDoc]);

  useEffect(() => {
    let current = true;
    setPageInput(String(page + 1));
    setResult(null);
    setBusy(true);
    setError(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const load = async () => {
      try {
        let parsed = cacheRef.current.get(page);
        if (!parsed) {
          const section = bookDoc?.sections[page];
          if (!section?.getReflowText) throw new Error('PDF text unavailable');
          const data = await section.getReflowText();
          // Coordinate reconstruction here only supports upright single columns.
          parsed =
            data.rotation % 360 !== 0
              ? { blocks: [], removedPageNumbers: [], warnings: ['rotated-page'] }
              : reflowPdfText(data.items, data.width, data.height, true);
          if (!current) return;
          cacheRef.current.set(page, parsed);
          while (cacheRef.current.size > 12) {
            const oldest = cacheRef.current.keys().next().value;
            if (oldest !== undefined) cacheRef.current.delete(oldest);
          }
        }
        if (current) setResult(parsed);
      } catch {
        if (current) setError(true);
      } finally {
        if (current) setBusy(false);
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [bookDoc, page]);

  const leave = (library: boolean) => {
    if (exiting.current) return;
    exiting.current = true;
    onClose();
    if (library) onGoToLibrary?.();
  };

  useReflowNavigation(rootRef, () => {
    if (settingsOpen) setSettingsOpen(false);
    else leave(true);
  });

  const returnToOriginal = () => {
    if (exiting.current) return;
    const view = getView(bookKey);
    // Closing never waits for PDF rendering. Even a stalled worker must not
    // trap the user in reflow. Only this explicit action moves the original.
    leave(false);
    if (view && count) {
      void Promise.resolve()
        .then(async () => {
          await view.goTo(page);
          if (!isPdfPageVisible(view.renderer, page)) throw new Error('PDF navigation failed');
        })
        .catch(() =>
          eventDispatcher.dispatch('toast', {
            message: _('Could not return to this PDF page.'),
            type: 'error',
          }),
        );
    }
  };

  const goPage = (next: number) => {
    if (!Number.isInteger(next) || next < 0 || next >= count) {
      setPageInput(String(page + 1));
      return;
    }
    tts.suspendFollowing();
    setPage(next);
  };

  return (
    <div
      ref={rootRef}
      role='dialog'
      aria-modal='true'
      aria-label={_('PDF Text Reflow')}
      tabIndex={-1}
      className='pdf-reflow-reader'
      style={
        {
          '--reflow-safe-top': `${Math.max(safeAreaInsets?.top ?? 0, systemUIVisible ? statusBarHeight : 0)}px`,
          '--reflow-safe-bottom': `${safeAreaInsets?.bottom ?? 0}px`,
        } as import('react').CSSProperties
      }
    >
      <header
        className='pdf-reflow-toolbar'
        data-visible={chromeVisible}
        aria-hidden={!chromeVisible}
        inert={!chromeVisible}
      >
        <button type='button' onClick={() => leave(true)}>
          {_('Go to Library')}
        </button>
        <button type='button' onClick={returnToOriginal}>
          {_('Switch to PDF')}
        </button>
        <button
          type='button'
          aria-label={_('Reflow Settings')}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          Aa
        </button>
        <button
          type='button'
          aria-label={_('Hide Reflow Controls')}
          onClick={() => {
            setSettingsOpen(false);
            setChromeVisible(false);
            rootRef.current?.focus();
          }}
        >
          ×
        </button>
      </header>
      {settingsOpen && (
        <section className='pdf-reflow-controls' aria-label={_('Reflow Settings')}>
          <div className='pdf-reflow-control-row'>
            <button type='button' onClick={() => setSettingsOpen(false)}>
              {_('Close Reflow Settings')}
            </button>
            <div className='pdf-reflow-font-controls'>
              <button
                type='button'
                aria-label={_('Decrease Reflow Font Size')}
                disabled={fontSize <= 16}
                onClick={() => setFontSize((n) => Math.max(16, n - 2))}
              >
                A−
              </button>
              <output aria-label={_('Font Size')}>{fontSize}</output>
              <button
                type='button'
                aria-label={_('Increase Reflow Font Size')}
                disabled={fontSize >= 36}
                onClick={() => setFontSize((n) => Math.min(36, n + 2))}
              >
                A＋
              </button>
            </div>
          </div>
          <label className='pdf-reflow-spacing'>
            {_('Line Spacing')}
            <select value={lineHeight} onChange={(e) => setLineHeight(Number(e.target.value))}>
              <option value={1.5}>1.5</option>
              <option value={1.85}>1.85</option>
              <option value={2.2}>2.2</option>
            </select>
          </label>
          <p className='pdf-reflow-notice'>
            {_(
              'For single-column text PDFs. Images, tables and formulas are not reconstructed; check the original page when needed.',
            )}
          </p>
        </section>
      )}
      <article
        ref={scrollRef}
        onPointerDown={(e) => {
          pointer.current = {
            x: e.clientX,
            y: e.clientY,
            time: Date.now(),
            moved: false,
            down: true,
          };
        }}
        onPointerUp={() => {
          if (pointer.current) pointer.current.down = false;
        }}
        onPointerMove={(e) => {
          const p = pointer.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) {
            p.moved = true;
            tts.suspendFollowing();
          }
        }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
        onWheel={tts.suspendFollowing}
        onKeyDown={(e) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key))
            tts.suspendFollowing();
        }}
        onScroll={() => {
          if (pointer.current?.down) {
            pointer.current.moved = true;
            tts.suspendFollowing();
          }
        }}
        onClick={(e) => {
          const p = pointer.current;
          pointer.current = null;
          if ((e.target as HTMLElement).closest('button, input, select, a')) return;
          if (window.getSelection()?.toString()) return;
          if (p && (p.moved || Date.now() - p.time > 450)) return;
          setSettingsOpen(false);
          setChromeVisible((v) => !v);
        }}
        className='pdf-reflow-page'
        aria-busy={busy}
        style={{ fontSize: `${fontSize}px`, lineHeight }}
      >
        {busy && <p role='status'>{_('Loading PDF text…')}</p>}
        {error && (
          <p role='alert'>{_('Could not read this page. Please use the original PDF view.')}</p>
        )}
        {!busy && result && (
          <>
            {result.warnings.length > 0 && (
              <p className='pdf-reflow-warning' role='status'>
                {_('This page may not reflow correctly. Please compare it with the original.')}
              </p>
            )}
            {result.blocks.length === 0 && (
              <p>
                {_('No usable text on this page. View the original page; OCR is not included.')}
              </p>
            )}
            {result.blocks.map((block, i) => {
              const parts: import('react').ReactNode[] = [];
              let cursor = 0;
              for (const h of tts.highlights.filter((h) => h.block === i)) {
                parts.push(block.text.slice(cursor, h.start));
                parts.push(
                  <mark data-reflow-tts key={h.start}>
                    {block.text.slice(h.start, h.end)}
                  </mark>,
                );
                cursor = h.end;
              }
              parts.push(block.text.slice(cursor));
              return block.kind === 'note' ? (
                <aside className='pdf-reflow-note' key={i}>
                  {parts}
                </aside>
              ) : (
                <p key={i}>{parts}</p>
              );
            })}
          </>
        )}
        <nav className='pdf-reflow-end-navigation' aria-label={_('Page Navigation')}>
          <button type='button' disabled={page <= 0} onClick={() => goPage(page - 1)}>
            {_('Previous Page')}
          </button>
          <span>
            {page + 1} / {count}
          </span>
          <button type='button' disabled={page >= count - 1} onClick={() => goPage(page + 1)}>
            {_('Next Page')}
          </button>
        </nav>
      </article>
      <footer className='pdf-reflow-dock' aria-label={_('Page Navigation')}>
        <div ref={playerHostRef} className='pdf-reflow-player-host' />
        <div className='pdf-reflow-tts' role='group' aria-label={_('Read Aloud')}>
          {tts.state === 'stopped' && !tts.pending && (
            <button
              type='button'
              disabled={tts.pending || !count}
              onClick={() => void tts.toggle()}
              aria-label={_('Read Aloud')}
            >
              {_('Read Aloud')}
            </button>
          )}
          {tts.pending && <span role='status'>{_('Loading…')}</span>}
          {!tts.following && (tts.state !== 'stopped' || tts.pending) && (
            <button type='button' onClick={tts.returnToSpeech}>
              {_('Return to Current Speech')}
            </button>
          )}
        </div>
        <button
          className='pdf-reflow-reveal'
          type='button'
          hidden={chromeVisible}
          aria-label={_('Show Reflow Controls')}
          onClick={() => setChromeVisible(true)}
        >
          {page + 1} / {count} · Aa
        </button>
        <form
          data-visible={chromeVisible}
          aria-hidden={!chromeVisible}
          inert={!chromeVisible}
          className='pdf-reflow-pagination'
          onSubmit={(e) => {
            e.preventDefault();
            goPage(Number(pageInput) - 1);
          }}
        >
          <button type='button' disabled={page <= 0} onClick={() => goPage(page - 1)}>
            {_('Previous Page')}
          </button>
          <label>
            <span className='sr-only'>{_('Original PDF Page')}</span>
            <input
              aria-label={_('Original PDF Page')}
              inputMode='numeric'
              type='number'
              min={1}
              max={count}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
            />
            <span> / {count}</span>
          </label>
          <button type='submit'>{_('Go')}</button>
          <button type='button' disabled={page >= count - 1} onClick={() => goPage(page + 1)}>
            {_('Next Page')}
          </button>
        </form>
      </footer>
    </div>
  );
};

export default PdfReflowDialog;
