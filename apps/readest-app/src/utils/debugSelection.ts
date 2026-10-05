/**
 * Preview-build test hook: create a text selection from a link, so device
 * tests can open the selection toolbar without a long-press (the Android
 * accessibility service used for testing cannot long-press).
 *
 *   readest-preview-debug://select?text=<words>[&occurrence=N]
 *   readest-preview-debug://select?block=<i>&start=<a>&end=<b>   (reflow only)
 *
 * It only places a real DOM selection and fires `selectionchange`; the app's
 * own selection handling (toolbar, mapping to the original PDF, AI seed) then
 * runs exactly as for a finger selection. Nothing is saved, sent or changed.
 *
 * Compiled in only when NEXT_PUBLIC_PREVIEW_DEBUG_LINKS=1 (preview workflow);
 * the Android scheme is registered only in the preview manifest.
 */

export const DEBUG_SCHEME = 'readest-preview-debug:';

export const debugLinksEnabled = () => process.env['NEXT_PUBLIC_PREVIEW_DEBUG_LINKS'] === '1';

export type DebugSelectRequest =
  | { kind: 'text'; text: string; occurrence: number }
  | { kind: 'block'; block: number; start: number; end: number };

const MAX_TEXT = 500;
const int = (value: string | null, min: number) => {
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : null;
};

/** Strict parser: anything unexpected is rejected rather than guessed. */
export function parseDebugSelectUrl(raw: string): DebugSelectRequest | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== DEBUG_SCHEME) return null;
  // `scheme://select?...` puts "select" in the host; accept `scheme:select` too.
  const action = url.host || url.pathname.replace(/^\/+/, '');
  if (action !== 'select') return null;
  const params = url.searchParams;
  const text = params.get('text');
  if (text !== null) {
    if (params.has('block')) return null;
    if (!text.trim() || text.length > MAX_TEXT) return null;
    const occurrence = params.has('occurrence') ? int(params.get('occurrence'), 1) : 1;
    if (occurrence === null) return null;
    return { kind: 'text', text, occurrence };
  }
  const block = int(params.get('block'), 0);
  const start = int(params.get('start'), 0);
  const end = int(params.get('end'), 1);
  if (block === null || start === null || end === null || end <= start) return null;
  if (end - start > MAX_TEXT) return null;
  return { kind: 'block', block, start, end };
}

/** Walk text nodes under `root`, returning the Range covering the N-th match
 * of `needle` (matches may span adjacent text nodes). */
export function findTextRange(root: Node, needle: string, occurrence = 1): Range | null {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const parent = t.parentElement;
    if (parent && parent.closest('script, style, rt')) continue;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  let at = -1;
  for (let i = 0; i < occurrence; i++) {
    at = text.indexOf(needle, at + 1);
    if (at < 0) return null;
  }
  const locate = (offset: number, preferEnd: boolean) => {
    let i = 0;
    while (i + 1 < nodes.length && (preferEnd ? starts[i + 1]! < offset : starts[i + 1]! <= offset))
      i++;
    return { node: nodes[i]!, offset: offset - starts[i]! };
  };
  const a = locate(at, false);
  const b = locate(at + needle.length, true);
  const range = doc.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Character range inside one reflow block (`[data-reflow-block=i]`). */
export function blockRange(root: ParentNode, block: number, start: number, end: number) {
  const el = root.querySelector(`[data-reflow-block="${block}"]`);
  if (!el) return null;
  if (end > (el.textContent?.length ?? 0)) return null;
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0;
  const range = doc.createRange();
  let started = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const next = seen + t.data.length;
    if (!started && start < next) {
      range.setStart(t, start - seen);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(t, end - seen);
      return range;
    }
    seen = next;
  }
  return null;
}

export type DebugSelectResult =
  | { ok: true; text: string; where: 'reflow' | 'original' }
  | { ok: false; reason: 'not-reading' | 'not-found' | 'block-needs-reflow' };

/**
 * Select inside the reflow article if it is open, otherwise in the visible
 * original-view section documents. Fires `selectionchange` on that document so
 * the regular selection pipeline picks it up.
 */
export function applyDebugSelection(
  request: DebugSelectRequest,
  targets: { reflow: HTMLElement | null; sections: Document[] },
): DebugSelectResult {
  const select = (range: Range, doc: Document, where: 'reflow' | 'original') => {
    const selection = doc.getSelection();
    if (!selection) return null;
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
    return { ok: true as const, text: range.toString(), where };
  };
  if (targets.reflow) {
    const range =
      request.kind === 'text'
        ? findTextRange(targets.reflow, request.text, request.occurrence)
        : blockRange(targets.reflow, request.block, request.start, request.end);
    if (!range) return { ok: false, reason: 'not-found' };
    return (
      select(range, targets.reflow.ownerDocument, 'reflow') ?? { ok: false, reason: 'not-found' }
    );
  }
  if (request.kind === 'block') return { ok: false, reason: 'block-needs-reflow' };
  if (!targets.sections.length) return { ok: false, reason: 'not-reading' };
  let remaining = request.occurrence;
  for (const doc of targets.sections) {
    if (!doc.body) continue;
    // Count matches in this section, then continue into the next one.
    for (let k = 1; ; k++) {
      const range = findTextRange(doc.body, request.text, k);
      if (!range) break;
      if (--remaining === 0)
        return select(range, doc, 'original') ?? { ok: false, reason: 'not-found' };
    }
  }
  return { ok: false, reason: 'not-found' };
}
