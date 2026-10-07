import { useEffect, type RefObject } from 'react';

/** Wide code listings and tables scroll sideways inside the reflow page. */
export const REFLOW_SCROLLER_SELECTOR = '.pdf-reflow-code, .pdf-reflow-table-wrap';

/**
 * Which edges of a sideways scroller hide content: `start`, `end`, `both` or
 * `none`. A tolerance of one pixel ignores sub-pixel rounding.
 */
export function overflowEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): 'none' | 'start' | 'end' | 'both' {
  const before = scrollLeft > 1;
  const after = scrollLeft + clientWidth < scrollWidth - 1;
  return before && after ? 'both' : before ? 'start' : after ? 'end' : 'none';
}

export function markReflowOverflow(element: HTMLElement) {
  const edges = overflowEdges(element.scrollLeft, element.clientWidth, element.scrollWidth);
  if (element.dataset['overflow'] !== edges) element.dataset['overflow'] = edges;
}

/**
 * Marks every sideways-scrolling code block and table in the page with
 * `data-overflow`, so the stylesheet can fade the edge that hides content.
 * Without the cue a cut-off line looks like the whole line.
 */
export function useReflowOverflowHints(
  pageRef: RefObject<HTMLElement | null>,
  content: unknown,
  fontSize: number,
) {
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const scrollers = () => [...page.querySelectorAll<HTMLElement>(REFLOW_SCROLLER_SELECTOR)];
    const update = () => scrollers().forEach(markReflowOverflow);
    update();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches(REFLOW_SCROLLER_SELECTOR))
        markReflowOverflow(target);
    };
    // Scroll events do not bubble; capture them on the page instead.
    page.addEventListener('scroll', onScroll, { capture: true, passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(page);
      scrollers().forEach((element) => {
        observer!.observe(element);
        if (element.firstElementChild) observer!.observe(element.firstElementChild);
      });
    }
    // Fonts and lazily rendered inline pictures can widen content later.
    const timer = setTimeout(update, 400);
    return () => {
      page.removeEventListener('scroll', onScroll, { capture: true });
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [pageRef, content, fontSize]);
}
