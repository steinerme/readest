import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PiHeadphonesFill, PiPauseFill, PiPlayFill, PiSparkleFill } from 'react-icons/pi';
import { useReaderStore } from '@/store/readerStore';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { eventDispatcher } from '@/utils/event';
import { useReadingChromeHidden } from '@/app/reader/hooks/useReadingChromeHidden';

type Playback = 'playing' | 'paused' | 'stopped';

/**
 * Two round floating buttons — listen and ask AI — that stay on the page while
 * you read and step aside whenever something else takes the screen: the
 * tap-to-show header/footer (and its font / colour / progress panels), the
 * sidebar / notebook, settings, or any sheet, dialog or popup. Because they
 * are simply absent in those states, they can never cover another control.
 */
export default function ReadingFloatingDock({
  bookKey,
  bottomInset = 0,
}: {
  bookKey: string;
  bottomInset?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hidden = useReadingChromeHidden(bookKey);
  const ttsEnabled = useReaderStore((s) => !!s.viewStates[bookKey]?.ttsEnabled);
  const reflowPage = usePdfReflowStore((s) => s.sessions[bookKey]?.page);
  const [playback, setPlayback] = useState<Playback>('stopped');
  const [bottom, setBottom] = useState(bottomInset + 24);

  useEffect(() => {
    const onState = (event: CustomEvent) => {
      const detail = event.detail as { bookKey?: string; state?: Playback };
      if (detail?.bookKey === bookKey && detail.state) setPlayback(detail.state);
    };
    eventDispatcher.on('tts-playback-state', onState);
    return () => eventDispatcher.off('tts-playback-state', onState);
  }, [bookKey]);
  useEffect(() => {
    if (!ttsEnabled) setPlayback('stopped');
  }, [ttsEnabled]);

  // The listening mini player (when shown) sits at the bottom of the page;
  // keep the dock above it. Nothing else needs avoiding: the footer, its
  // panels and every sheet hide the dock entirely.
  useLayoutEffect(() => {
    const cell = ref.current?.closest<HTMLElement>('[data-view-transition-root]');
    if (!cell) return;
    const measure = () => {
      const frame = cell.getBoundingClientRect();
      let space = bottomInset + 24;
      for (const item of cell.querySelectorAll<HTMLElement>(
        '[data-reading-tts-player="visible"]',
      )) {
        const rect = item.getBoundingClientRect();
        if (rect.height && rect.width) space = Math.max(space, frame.bottom - rect.top + 16);
      }
      setBottom(Math.min(space, Math.max(bottomInset + 24, frame.height - 120)));
    };
    const observer = new MutationObserver(measure);
    const size = new ResizeObserver(measure);
    observer.observe(cell, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ['class', 'style', 'data-reading-tts-player'],
    });
    size.observe(cell);
    cell.addEventListener('transitionend', measure);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      size.disconnect();
      window.removeEventListener('resize', measure);
      cell.removeEventListener('transitionend', measure);
    };
  }, [bookKey, bottomInset]);

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const listen = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (!ttsEnabled) {
      void eventDispatcher.dispatch('tts-speak', {
        bookKey,
        ...(typeof reflowPage === 'number' ? { index: reflowPage } : {}),
      });
    } else {
      void eventDispatcher.dispatch('tts-toggle-play', { bookKey });
    }
  };
  const listenLabel = !ttsEnabled ? '听书' : playback === 'playing' ? '暂停朗读' : '继续朗读';
  const ListenIcon = !ttsEnabled
    ? PiHeadphonesFill
    : playback === 'playing'
      ? PiPauseFill
      : PiPlayFill;
  const buttonClass =
    'claude-fab pointer-events-auto flex size-12 items-center justify-center rounded-full';
  return (
    <div
      ref={ref}
      data-reading-dock={hidden ? 'hidden' : 'visible'}
      aria-hidden={hidden}
      // inert keeps hidden buttons out of focus order and away from touches
      inert={hidden}
      className={`pointer-events-none absolute right-4 z-30 flex flex-col items-center gap-3 transition-[opacity,translate] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        hidden ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
      }`}
      style={{ bottom }}
    >
      <button
        type='button'
        id='reading-dock-listen'
        aria-label={listenLabel}
        title={listenLabel}
        className={`reading-listen-floating ${buttonClass}`}
        onPointerDown={stop}
        onClick={listen}
      >
        <ListenIcon aria-hidden='true' size={22} />
      </button>
      <button
        type='button'
        id='reading-dock-ai'
        aria-label='问这本书'
        title='问 AI'
        className={`reading-ai-floating claude-fab-accent ${buttonClass}`}
        onPointerDown={stop}
        onClick={(event) => {
          event.stopPropagation();
          void eventDispatcher.dispatch('reading-ai-open', { bookKey, mode: 'book' });
        }}
      >
        <PiSparkleFill aria-hidden='true' size={22} />
      </button>
    </div>
  );
}
