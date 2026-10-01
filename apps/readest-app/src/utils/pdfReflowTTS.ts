import { normalizePdfSpeechText, type ReflowPage } from './pdfReflow';

export interface ReflowHighlight {
  block: number;
  start: number;
  end: number;
}

/** Never search for the sounding sentence in the page. The Range's text-layer
 * offsets identify its exact PDF-item-stream occurrence, including repeated
 * lines and visually reordered runs. If PDF.js/transformers changed the source
 * stream we cannot prove provenance and deliberately paint nothing. */
export function mapPdfSpeechRange(page: ReflowPage, range: Range): ReflowHighlight[] {
  if (!page.sourceMap || page.sourceText === undefined || range.collapsed) return [];
  try {
    const doc = range.startContainer.ownerDocument;
    const layer = doc?.querySelector('.textLayer');
    if (!layer || !layer.contains(range.startContainer) || !layer.contains(range.endContainer))
      return [];
    if (normalizePdfSpeechText(layer.textContent ?? '') !== page.sourceText) return [];
    const prefix = doc!.createRange();
    prefix.selectNodeContents(layer);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = normalizePdfSpeechText(prefix.toString()).length;
    prefix.setEnd(range.endContainer, range.endOffset);
    const end = normalizePdfSpeechText(prefix.toString()).length;
    if (end <= start) return [];
    const highlights: ReflowHighlight[] = [];
    page.sourceMap.forEach((source, block) => {
      let from = -1;
      for (let i = 0; i <= source.length; i++) {
        const offset = source[i] ?? -1;
        const inside = offset >= start && offset < end;
        // Include inserted whitespace only between two mapped characters.
        if (inside && from < 0) from = i;
        if ((!inside && offset !== -1 && from >= 0) || (i === source.length && from >= 0)) {
          let to = i;
          while (to > from && source[to - 1] === -1) to--;
          if (to > from) highlights.push({ block, start: from, end: to });
          from = -1;
        }
      }
    });
    return highlights;
  } catch {
    return [];
  }
}
