import { useEffect, useState } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useNotebookStore } from '@/store/notebookStore';
import { useSettingsStore } from '@/store/settingsStore';

const OVERLAY_SELECTOR = '[data-capture-blocking-overlay="true"]';

/**
 * True while the reader is showing something that should own the screen: the
 * tap-to-show header/footer bars (which include the font / colour / progress
 * panels), an unpinned sidebar or notebook, the settings dialog, or any
 * modal / sheet / popup layer (they all mark themselves with
 * `data-capture-blocking-overlay`). Floating reading controls hide while this
 * is true and come back when the screen is plain reading again.
 */
export function useReadingChromeHidden(bookKey: string): boolean {
  const barsShown = useReaderStore((s) => s.hoveredBookKey === bookKey);
  const sideBar = useSidebarStore((s) => s.isSideBarVisible && !s.isSideBarPinned);
  const notebook = useNotebookStore((s) => s.isNotebookVisible && !s.isNotebookPinned);
  const settingsDialog = useSettingsStore((s) => s.isSettingsDialogOpen);
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      timer = undefined;
      setOverlay(!!document.querySelector(OVERLAY_SELECTOR));
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(check, 40);
    };
    check();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-capture-blocking-overlay'],
    });
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return barsShown || sideBar || notebook || settingsDialog || overlay;
}
