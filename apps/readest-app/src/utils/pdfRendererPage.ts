interface PdfPageRenderer {
  /** fixed-layout's physical section index (not the spread index). */
  index?: number;
  /** Available on reflowable renderers, absent on fixed-layout. */
  primaryIndex?: number;
  getContents?: () => { index?: number }[];
}
const valid = (index: unknown): index is number =>
  typeof index === 'number' && Number.isInteger(index) && index >= 0;

export function getPdfRendererPage(renderer: PdfPageRenderer | undefined): number | undefined {
  if (!renderer) return undefined;
  if (valid(renderer.index)) return renderer.index;
  if (valid(renderer.primaryIndex)) return renderer.primaryIndex;
  return renderer.getContents?.().find((content) => valid(content.index))?.index;
}

export function isPdfPageVisible(renderer: PdfPageRenderer, page: number): boolean {
  // Prefer the active physical index. getContents may include prefetched pages
  // in scroll mode or both members of a spread, so it is only a fallback.
  if (valid(renderer.index)) return renderer.index === page;
  if (valid(renderer.primaryIndex)) return renderer.primaryIndex === page;
  return renderer.getContents?.().some((content) => content.index === page) ?? false;
}
