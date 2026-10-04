import { useLayoutEffect, useRef, useState } from 'react';
import { eventDispatcher } from '@/utils/event';

export default function ReadingAIFloatingButton({
  bookKey,
  bottomInset = 0,
}: {
  bookKey: string;
  bottomInset?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [bottom, setBottom] = useState(bottomInset + 24);
  useLayoutEffect(() => {
    const cell = ref.current?.closest<HTMLElement>('[data-view-transition-root]');
    if (!cell) return;
    const measure = () => {
      const frame = cell.getBoundingClientRect();
      let space = bottomInset + 24;
      for (const item of cell.querySelectorAll<HTMLElement>(
        '.footer-bar[data-visible="true"], .footer-bar[data-visible="true"] [data-state="open"], [data-reading-tts-player="visible"]',
      )) {
        const rect = item.getBoundingClientRect();
        if (rect.height && rect.width) space = Math.max(space, frame.bottom - rect.top + 16);
      }
      setBottom(Math.min(space, Math.max(bottomInset + 24, frame.height - 76)));
    };
    const observer = new MutationObserver(measure);
    const size = new ResizeObserver(measure);
    observer.observe(cell, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ['class', 'style', 'data-visible', 'data-state', 'data-reading-tts-player'],
    });
    size.observe(cell);
    // The footer's font/color/progress panels are absolute children that extend
    // above the 64px bar; transitions change their rect without a DOM change.
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
  return (
    <button
      ref={ref}
      type='button'
      aria-label='问这本书'
      title='问 AI'
      className='reading-ai-floating absolute right-5 z-30 flex size-14 items-center justify-center rounded-full bg-neutral/80 text-neutral-content shadow-lg backdrop-blur-sm'
      style={{ bottom }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void eventDispatcher.dispatch('reading-ai-open', { bookKey, mode: 'book' });
      }}
    >
      <span aria-hidden='true' className='text-lg font-semibold'>
        AI<span className='align-top text-xs'>✦</span>
      </span>
    </button>
  );
}
