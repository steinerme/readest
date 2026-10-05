import { useEffect } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { eventDispatcher } from '@/utils/event';
import {
  applyDebugSelection,
  debugLinksEnabled,
  parseDebugSelectUrl,
  type DebugSelectResult,
} from '@/utils/debugSelection';

/** Where a debug selection should land: the open reflow article, else the
 * section documents of the first open book. */
export function debugSelectionTargets() {
  const reflow = document.querySelector<HTMLElement>('.pdf-reflow-reader article');
  const { bookKeys, getView } = useReaderStore.getState();
  const sections: Document[] = [];
  for (const key of bookKeys) {
    const contents = getView(key)?.renderer?.getContents() ?? [];
    for (const item of contents) if (item.doc) sections.push(item.doc);
    if (sections.length) break;
  }
  return { reflow, sections };
}

const MESSAGES: Record<Exclude<DebugSelectResult, { ok: true }>['reason'], string> = {
  'not-reading': '调试选区：没有打开的书',
  'not-found': '调试选区：当前页没有找到这段文字',
  'block-needs-reflow': '调试选区：按段落编号选取只支持重排模式',
};

export function handleDebugSelectionUrl(url: string): DebugSelectResult | null {
  const request = parseDebugSelectUrl(url);
  if (!request) return null;
  const result = applyDebugSelection(request, debugSelectionTargets());
  void eventDispatcher.dispatch('toast', {
    type: result.ok ? 'info' : 'error',
    message: result.ok ? `调试选区：已选中 ${result.text.length} 字` : MESSAGES[result.reason],
    timeout: 2000,
  });
  return result;
}

/** Preview builds only: `readest-preview-debug://select?...` links. */
export function useDebugSelectionLinks() {
  useEffect(() => {
    if (!debugLinksEnabled()) return;
    // One intent can reach JS through more than one native channel.
    const recent = new Map<string, number>();
    const onLink = (event: CustomEvent) => {
      const { urls } = (event.detail ?? {}) as { urls?: string[] };
      const now = Date.now();
      for (const url of urls ?? []) {
        if (now - (recent.get(url) ?? 0) < 1500) continue;
        recent.set(url, now);
        // Let the app finish handling the intent / page settle before selecting.
        setTimeout(() => handleDebugSelectionUrl(url), 300);
      }
    };
    eventDispatcher.on('debug-selection-url', onLink);
    return () => eventDispatcher.off('debug-selection-url', onLink);
  }, []);
}
