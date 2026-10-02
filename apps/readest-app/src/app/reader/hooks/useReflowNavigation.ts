import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useDeviceControlStore } from '@/store/deviceStore';
import { eventDispatcher } from '@/utils/event';

/** This full-screen reader owns Back, independently of the underlying PDF's
 * bars/menus. Latest refs avoid the old Dialog's stale onClose/page closure. */
export function useReflowNavigation(root: RefObject<HTMLDivElement | null>, onBack: () => void) {
  const { appService } = useEnv();
  const { acquireBackKeyInterception, releaseBackKeyInterception } = useDeviceControlStore();
  const latest = useRef(onBack);
  useLayoutEffect(() => {
    latest.current = onBack;
  }, [onBack]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const nativeBack = (event: CustomEvent) => {
      if (event.detail?.keyName !== 'Back') return false;
      // A borrowed player sheet is nested in the reflow host. Let its own
      // native Back listener dismiss it before this reader can exit.
      if (root.current?.querySelector('dialog[open]')) return false;
      latest.current();
      return true;
    };
    const keyboard = (event: KeyboardEvent) => {
      if (root.current?.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        latest.current();
      } else if (event.key === 'Tab' && root.current) {
        const nodes = [
          ...root.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ),
        ].filter((node) => !node.closest('[inert], [hidden], [aria-hidden="true"]'));
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first) {
          event.preventDefault();
          root.current.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === root.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === root.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', keyboard, true);
    if (appService?.isAndroidApp) {
      acquireBackKeyInterception();
      eventDispatcher.onSync('native-key-down', nativeBack);
    }
    return () => {
      window.removeEventListener('keydown', keyboard, true);
      if (appService?.isAndroidApp) {
        eventDispatcher.offSync('native-key-down', nativeBack);
        releaseBackKeyInterception();
      }
      if (previous?.isConnected) previous.focus();
    };
  }, [root, appService?.isAndroidApp, acquireBackKeyInterception, releaseBackKeyInterception]);
}
