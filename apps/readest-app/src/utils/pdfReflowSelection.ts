import { normalizePdfSpeechText, type ReflowPage } from './pdfReflow';

/** Resolve only a contiguous, provable source interval. Never search repeated
 * phrases or generate a CFI from the reflow DOM. */
export function mapReflowSelection(
  page: ReflowPage,
  article: HTMLElement,
  range: Range,
  doc: Document,
): Range | null {
  const layer = doc.querySelector('.textLayer');
  if (
    !layer ||
    !page.sourceMap ||
    normalizePdfSpeechText(layer.textContent ?? '') !== page.sourceText
  )
    return null;
  const sourceOffsets: number[] = [];
  for (const block of article.querySelectorAll<HTMLElement>('[data-reflow-block]')) {
    if (!range.intersectsNode(block)) continue;
    const index = Number(block.dataset['reflowBlock']);
    const selected = range.cloneRange();
    if (!block.contains(selected.startContainer)) selected.setStart(block, 0);
    if (!block.contains(selected.endContainer)) selected.setEnd(block, block.childNodes.length);
    const prefix = article.ownerDocument.createRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(selected.startContainer, selected.startOffset);
    const start = prefix.toString().length;
    const end = start + selected.toString().length;
    sourceOffsets.push(...(page.sourceMap[index]?.slice(start, end).filter((n) => n >= 0) ?? []));
  }
  if (!sourceOffsets.length) return null;
  const start = sourceOffsets[0]!;
  const end = sourceOffsets.at(-1)! + 1;
  // Coordinate reconstruction can reorder runs; an ambiguous/disjoint
  // selection must not become an annotation over unrelated intervening text.
  for (let i = 1; i < sourceOffsets.length; i++)
    if (sourceOffsets[i] !== sourceOffsets[i - 1]! + 1) return null;
  const walker = doc.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const chars: Array<{ node: Text; offset: number }> = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    for (let i = 0; i < text.length; i++) {
      const length = normalizePdfSpeechText(text.data[i] ?? '').length;
      for (let j = 0; j < length; j++) chars.push({ node: text, offset: i });
    }
  }
  const a = chars[start],
    b = chars[end - 1];
  if (!a || !b) return null;
  const original = doc.createRange();
  original.setStart(a.node, a.offset);
  original.setEnd(b.node, b.offset + 1);
  return original;
}
