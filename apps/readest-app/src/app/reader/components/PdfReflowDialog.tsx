import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTTSPlayerHostStore } from '@/store/ttsPlayerHostStore';
import { useThemeStore } from '@/store/themeStore';
import { eventDispatcher } from '@/utils/event';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { mapReflowSelection } from '@/utils/pdfReflowSelection';
import { mapPdfSpeechRange } from '@/utils/pdfReflowTTS';
import { getHighlightColorHex } from '../utils/annotatorUtil';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { usePdfReflowTTS } from '../hooks/usePdfReflowTTS';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { reflowPdfText, type ReflowPage } from '@/utils/pdfReflow';
import '@/styles/pdf-reflow.css';
import { readReflowSession, writeReflowSession } from '@/utils/pdfReflowSession';
import { getPdfRendererPage, isPdfPageVisible } from '@/utils/pdfRendererPage';
import { getBaseFontFamily } from '@/utils/style';

interface Props {
  bookKey: string;
  /** Manual original→reflow entry overrides the saved page. Default opening
   * leaves this undefined to restore the previous reflow session. */
  initialPage?: number;
  onClose: () => void;
  onGoToLibrary?: () => void;
}

/** Page-based rendering mode inside the existing reader. Chrome, navigation,
 * settings, bookmarks and notes use the original services. Annotations require
 * a proven original text-layer Range; never generate CFIs from reflow DOM. */
const PdfReflowDialog = ({ bookKey, initialPage, onClose, onGoToLibrary }: Props) => {
  const _ = useTranslation();
  const { safeAreaInsets, statusBarHeight, systemUIVisible } = useThemeStore();
  const { appService } = useEnv();
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
  const { getBookData, getConfig } = useBookDataStore();
  const { settings } = useSettingsStore();
  const config = getConfig(bookKey);
  const [relocationEpoch, setRelocationEpoch] = useState(0);
  const { getView, getProgress, getViewSettings, hoveredBookKey, setHoveredBookKey } =
    useReaderStore();
  const viewSettings = getViewSettings(bookKey);
  const view = getView(bookKey);
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
  const fontSize =
    (viewSettings?.defaultFontSize ?? 18) *
    (appService?.isMobile ? 1.25 : 1) *
    ((viewSettings?.zoomLevel ?? 100) / 100);
  const lineHeight = viewSettings?.lineHeight ?? 1.85;
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

  const currentRef = useRef({ page, tts, returnToOriginal });
  currentRef.current = { page, tts, returnToOriginal };
  const navigate = useCallback(
    async (target: number | string) => {
      const resolved =
        typeof target === 'number' ? { index: target } : await view?.resolveNavigation(target);
      const next = resolved?.index;
      if (next == null || !Number.isInteger(next) || next < 0 || next >= count) return;
      currentRef.current.tts.suspendFollowing();
      try {
        await view?.goTo(target);
        if (view && !isPdfPageVisible(view.renderer, next))
          throw new Error('PDF navigation failed');
        setPage(next);
      } catch {
        void eventDispatcher.dispatch('toast', {
          message: _('Could not return to this PDF page.'),
          type: 'error',
        });
      }
    },
    [count, view],
  );

  useLayoutEffect(() => {
    const store = usePdfReflowStore.getState();
    store.setSession(bookKey, {
      page,
      count,
      navigate,
      close: () => currentRef.current.returnToOriginal(),
      speak: () => currentRef.current.tts.toggle(),
      returnToSpeech: () => currentRef.current.tts.returnToSpeech(),
    });
  }, [bookKey, page, count, navigate]);
  useLayoutEffect(
    () => () => usePdfReflowStore.getState().clearSession(bookKey, navigate),
    [bookKey, navigate],
  );

  // The original location is authoritative for services (TOC, bookmarks,
  // search, annotations, history, TTS). Navigation there updates this mode,
  // while manual reflow navigation goes through the same view.goTo service.
  useEffect(() => {
    if (!view) return;
    let active = true;
    let explicitNavigation = false;
    const onRelocate = () => {
      setRelocationEpoch((n) => n + 1);
      const state = currentRef.current.tts;
      if (!explicitNavigation && state.state !== 'stopped' && !state.following) return;
      explicitNavigation = false;
      const next = getPdfRendererPage(view.renderer);
      if (next != null && next >= 0 && next < count && next !== currentRef.current.page) {
        setPage(next);
      }
    };
    view.addEventListener('relocate', onRelocate);
    const onNavigate = (event: CustomEvent) => {
      if (event.detail?.bookKey === bookKey) {
        explicitNavigation = true;
        currentRef.current.tts.suspendFollowing();
      }
    };
    eventDispatcher.on('navigate', onNavigate);
    if (count && getPdfRendererPage(view.renderer) !== page) {
      void Promise.resolve(view.goTo(page)).catch(() => {
        if (active) setError(true);
      });
    }
    return () => {
      active = false;
      view.removeEventListener('relocate', onRelocate);
      eventDispatcher.off('navigate', onNavigate);
    };
  }, [view, bookKey, count]);

  useEffect(() => {
    let lastRange: Range | null = null;
    const notifySelection = () => {
      const selected = window.getSelection();
      const article = scrollRef.current;
      if (
        pointer.current?.down ||
        !selected?.rangeCount ||
        selected.isCollapsed ||
        !article ||
        !result
      )
        return;
      const visibleRange = selected.getRangeAt(0);
      if (
        !article.contains(visibleRange.startContainer) ||
        !article.contains(visibleRange.endContainer)
      )
        return;
      if (
        lastRange &&
        lastRange.startContainer === visibleRange.startContainer &&
        lastRange.endContainer === visibleRange.endContainer &&
        lastRange.startOffset === visibleRange.startOffset &&
        lastRange.endOffset === visibleRange.endOffset
      )
        return;
      lastRange = visibleRange.cloneRange();
      const doc = view?.renderer.getContents().find((item) => item.index === page)?.doc;
      const originalRange = doc ? mapReflowSelection(result, article, visibleRange, doc) : null;
      // Text tools work without a persisted anchor; annotation tools require
      // an exact original CFI. No synthetic positions are ever saved.
      void eventDispatcher.dispatch('footnote-selection', {
        key: bookKey,
        index: page,
        range: visibleRange.cloneRange(),
        cfi: originalRange ? view?.getCFI(page, originalRange) : undefined,
        reflow: true,
        originalRange,
        quickAction: viewSettings?.enableAnnotationQuickActions
          ? viewSettings.annotationQuickAction
          : undefined,
      });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(notifySelection, 120);
    };
    let timer: ReturnType<typeof setTimeout>;
    document.addEventListener('selectionchange', schedule);
    scrollRef.current?.addEventListener('pointerup', schedule);
    const article = scrollRef.current;
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      article?.removeEventListener('pointerup', schedule);
      void eventDispatcher.dispatch('footnote-selection', { key: bookKey });
    };
  }, [
    bookKey,
    page,
    result,
    view,
    viewSettings?.enableAnnotationQuickActions,
    viewSettings?.annotationQuickAction,
  ]);

  // Reserve the SAME original chrome's measured height. Footer panels are
  // absolute children, so include the open panel rather than only the 64px bar.
  useLayoutEffect(() => {
    const cell = document.getElementById(`gridcell-${bookKey}`);
    const root = rootRef.current;
    if (!cell || !root) return;
    const measure = () => {
      const frame = cell.getBoundingClientRect();
      const header = cell.querySelector<HTMLElement>('.header-bar[data-visible="true"]');
      const footer = cell.querySelector<HTMLElement>('.footer-bar[data-visible="true"]');
      const panel = footer?.querySelector<HTMLElement>('[data-state="open"]');
      const top = header ? Math.max(0, header.getBoundingClientRect().bottom - frame.top) : 0;
      const bottom = footer
        ? Math.max(
            0,
            frame.bottom -
              Math.min(
                footer.getBoundingClientRect().top,
                panel?.getBoundingClientRect().top ?? Infinity,
              ),
          )
        : 0;
      root.dataset['chromePanel'] = panel ? 'true' : 'false';
      root.style.setProperty('--shared-chrome-top', `${top}px`);
      root.style.setProperty('--shared-chrome-bottom', `${bottom}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    const header = cell.querySelector('.header-bar'),
      footer = cell.querySelector('.footer-bar');
    if (header) observer.observe(header);
    if (footer) {
      observer.observe(footer);
      footer.querySelectorAll('[data-state]').forEach((el) => observer.observe(el));
    }
    observer.observe(cell);
    const mutations = new MutationObserver(measure);
    if (header) mutations.observe(header, { attributes: true, attributeFilter: ['data-visible'] });
    if (footer)
      mutations.observe(footer, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-visible', 'data-state'],
      });
    cell.addEventListener('transitionend', measure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cell.removeEventListener('transitionend', measure);
    };
  }, [bookKey]);

  const annotations = useMemo(() => {
    const doc = view?.renderer.getContents().find((item) => item.index === page)?.doc;
    if (!doc || !result) return [];
    return (config?.booknotes ?? []).flatMap((note) => {
      if (note.type !== 'annotation' || note.deletedAt || !note.cfi || !note.style) return [];
      try {
        const resolved = view?.resolveCFI(note.cfi);
        if (resolved?.index !== page || !resolved.anchor) return [];
        const range = resolved.anchor(doc);
        if (!range || typeof range.cloneRange !== 'function') return [];
        return mapPdfSpeechRange(result, range).map((highlight) => ({ ...highlight, note }));
      } catch {
        return [];
      }
    });
  }, [config?.booknotes, result, view, page, relocationEpoch]);

  const goPage = (next: number) => {
    void navigate(next);
  };

  return (
    <div
      ref={rootRef}
      role='region'
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
          if (pointer.current) {
            pointer.current.down = false;
            pointer.current.moved = true;
          }
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
          // Portal events can bubble through the React owner tree. Reflow
          // alone owns its taps; never let the hidden PDF paginate as well.
          e.stopPropagation();
          const p = pointer.current;
          pointer.current = null;
          if (
            (e.target as HTMLElement).closest('button, input, select, a, [data-reflow-annotation]')
          )
            return;
          if (window.getSelection()?.toString()) return;
          if (p && (p.moved || Date.now() - p.time > 450)) return;
          // Use the visible article's bounds, not the window: shared panels,
          // split views and landscape can change the reader's position/width.
          const { left, width } = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - left;
          if (width > 0 && x >= 0 && x <= width) {
            if (x < width / 4) {
              if (!busy && page > 0) goPage(page - 1);
              return;
            }
            if (x > (width * 3) / 4) {
              if (!busy && page < count - 1) goPage(page + 1);
              return;
            }
          }
          setHoveredBookKey(hoveredBookKey === bookKey ? '' : bookKey);
        }}
        className='pdf-reflow-page'
        aria-busy={busy}
        style={{
          fontSize: `${fontSize}px`,
          lineHeight,
          fontFamily: viewSettings?.defaultFont ? getBaseFontFamily(viewSettings) : undefined,
          fontWeight: viewSettings?.fontWeight,
          paddingInline: `${Math.max(12, viewSettings?.marginLeftPx ?? 24)}px`,
          letterSpacing: `${viewSettings?.letterSpacing ?? 0}px`,
          wordSpacing: `${viewSettings?.wordSpacing ?? 0}px`,
          textAlign: viewSettings?.fullJustification ? 'justify' : 'start',
        }}
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
              const spoken = tts.highlights.filter((h) => h.block === i);
              const notes = annotations.filter((h) => h.block === i);
              const points = [
                ...new Set([
                  0,
                  block.text.length,
                  ...spoken.flatMap((h) => [h.start, h.end]),
                  ...notes.flatMap((h) => [h.start, h.end]),
                ]),
              ].sort((a, b) => a - b);
              const parts = points.slice(0, -1).map((start, j) => {
                const end = points[j + 1]!;
                const speech = spoken.some((h) => start >= h.start && end <= h.end);
                const annotation = notes.find((h) => start >= h.start && end <= h.end)?.note;
                const text = block.text.slice(start, end);
                if (annotation)
                  return (
                    <mark
                      key={start}
                      data-reflow-tts={speech || undefined}
                      data-reflow-annotation={annotation.cfi}
                      style={{
                        background: speech
                          ? undefined
                          : annotation.style === 'highlight'
                            ? (getHighlightColorHex(settings, annotation.color) ?? '#f8d878')
                            : 'transparent',
                        textDecoration: annotation.style !== 'highlight' ? 'underline' : undefined,
                        textDecorationStyle: annotation.style === 'squiggly' ? 'wavy' : undefined,
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        const range = document.createRange();
                        range.selectNodeContents(event.currentTarget);
                        void eventDispatcher.dispatch('footnote-selection', {
                          key: bookKey,
                          index: page,
                          range,
                          cfi: annotation.cfi,
                          annotated: true,
                          reflow: true,
                          originalRange: (() => {
                            try {
                              const doc = view?.renderer
                                .getContents()
                                .find((item) => item.index === page)?.doc;
                              return doc ? view?.resolveCFI(annotation.cfi).anchor(doc) : undefined;
                            } catch {
                              return undefined;
                            }
                          })(),
                        });
                      }}
                    >
                      {text}
                    </mark>
                  );
                return speech ? (
                  <mark data-reflow-tts key={start}>
                    {text}
                  </mark>
                ) : (
                  text
                );
              });
              return block.kind === 'note' ? (
                <aside data-reflow-block={i} className='pdf-reflow-note' key={i}>
                  {parts}
                </aside>
              ) : (
                <p data-reflow-block={i} key={i}>
                  {parts}
                </p>
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
      <div className='pdf-reflow-listening-dock'>
        <div ref={playerHostRef} className='pdf-reflow-player-host' />
        {!tts.following && tts.state !== 'stopped' && (
          <button type='button' onClick={tts.returnToSpeech}>
            {_('Back to Read Aloud')}
          </button>
        )}
      </div>
    </div>
  );
};

export default PdfReflowDialog;
