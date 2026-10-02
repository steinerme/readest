import { useEffect, type RefObject } from 'react';
import { setSelectionSuppressed } from '@/utils/bridge';

/** Android's floating menu is outside WebView stacking contexts. Arm before
 * native long-press starts; never clear the DOM selection or its drag handles.
 * Scope to this reading article, not settings/search/editable inputs. */
export function useReflowSelectionMenu(
  articleRef: RefObject<HTMLElement | null>,
  android: boolean,
) {
  useEffect(() => {
    const article = articleRef.current;
    if (!android || !article) return;
    const doc = article.ownerDocument;
    let enabled = false;
    let holding = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const set = (next: boolean) => {
      if (enabled === next) return;
      enabled = next;
      void setSelectionSuppressed({ target: 'menu', suppressed: next }).catch(() => {
        // Let a later event retry after a transient native-bridge failure.
        if (active && enabled === next) enabled = !next;
      });
    };
    const editable = (node: EventTarget | null) =>
      node instanceof Element &&
      !!node.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
    const selected = () => {
      const selection = doc.getSelection();
      return (
        !!selection?.rangeCount &&
        !selection.isCollapsed &&
        article.contains(selection.anchorNode) &&
        article.contains(selection.focusNode)
      );
    };
    const sync = () => {
      clearTimeout(timer);
      if (selected()) set(true);
      else if (!holding) set(false);
    };
    const down = (event: Event) => {
      clearTimeout(timer);
      if (editable(event.target)) {
        holding = false;
        set(false);
        return;
      }
      holding = true;
      set(true);
    };
    const up = () => {
      holding = false;
      clearTimeout(timer);
      // Chromium may commit long-press selection just after pointercancel/up.
      timer = setTimeout(sync, 200);
    };
    const context = (event: Event) => {
      if (editable(event.target)) return;
      set(true);
      event.preventDefault();
      event.stopPropagation();
    };
    const focus = (event: Event) => {
      if (editable(event.target)) {
        clearTimeout(timer);
        holding = false;
        set(false);
      } else sync();
    };
    const change = () => {
      if (editable(doc.activeElement)) set(false);
      else sync();
    };
    article.addEventListener('pointerdown', down, true);
    article.addEventListener('touchstart', down, { capture: true, passive: true });
    article.addEventListener('contextmenu', context, true);
    doc.addEventListener('pointerup', up, true);
    doc.addEventListener('pointercancel', up, true);
    doc.addEventListener('touchend', up, true);
    doc.addEventListener('touchcancel', up, true);
    doc.addEventListener('selectionchange', change);
    doc.addEventListener('focusin', focus, true);
    sync();
    return () => {
      active = false;
      clearTimeout(timer);
      article.removeEventListener('pointerdown', down, true);
      article.removeEventListener('touchstart', down, true);
      article.removeEventListener('contextmenu', context, true);
      doc.removeEventListener('pointerup', up, true);
      doc.removeEventListener('pointercancel', up, true);
      doc.removeEventListener('touchend', up, true);
      doc.removeEventListener('touchcancel', up, true);
      doc.removeEventListener('selectionchange', change);
      doc.removeEventListener('focusin', focus, true);
      if (enabled)
        void setSelectionSuppressed({ target: 'menu', suppressed: false }).catch(() => {});
    };
  }, [articleRef, android]);
}
