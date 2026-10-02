import { describe, expect, it } from 'vitest';
import { mapReflowSelection } from '@/utils/pdfReflowSelection';
import type { ReflowPage } from '@/utils/pdfReflow';
function fixture(source: string, text: string, map: number[]) {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = '<div class="textLayer"><span></span></div>';
  doc.querySelector('span')!.textContent = source;
  const article = document.createElement('article');
  article.innerHTML = '<p data-reflow-block="0"></p>';
  article.querySelector('p')!.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(article.querySelector('p')!);
  const page: ReflowPage = {
    blocks: [{ kind: 'paragraph', text }],
    warnings: [],
    removedPageNumbers: [],
    sourceText: source.normalize('NFKC').replace(/[\s\u00ad]/gu, ''),
    sourceMap: [map],
  };
  return { doc, article, range, page };
}
describe('reflow selection proven original anchor', () => {
  it('maps the second repeated sentence, never searches the first occurrence', () => {
    const f = fixture('你好你好', '你好', [2, 3]);
    const r = mapReflowSelection(f.page, f.article, f.range, f.doc)!;
    expect(r.startOffset).toBe(2);
    expect(r.endOffset).toBe(4);
    expect(r.toString()).toBe('你好');
  });
  it('ignores introduced spacing but keeps original whitespace inside the real range', () => {
    const f = fixture('Hello world', 'Hello world', [0, 1, 2, 3, 4, -1, 5, 6, 7, 8, 9]);
    expect(mapReflowSelection(f.page, f.article, f.range, f.doc)!.toString()).toBe('Hello world');
  });
  it('rejects visually reordered or disjoint source offsets', () => {
    const f = fixture('ABCD', 'AC', [0, 2]);
    expect(mapReflowSelection(f.page, f.article, f.range, f.doc)).toBeNull();
    f.page.sourceMap = [[2, 0]];
    expect(mapReflowSelection(f.page, f.article, f.range, f.doc)).toBeNull();
  });
  it('rejects a transformed or mismatched original layer rather than storing wrong notes', () => {
    const f = fixture('AB', 'AB', [0, 1]);
    f.doc.querySelector('span')!.textContent = 'CD';
    expect(mapReflowSelection(f.page, f.article, f.range, f.doc)).toBeNull();
  });
  it('maps compatibility ligatures to full original glyph boundaries', () => {
    const f = fixture('ﬃX', 'ffiX', [0, 1, 2, 3]);
    expect(mapReflowSelection(f.page, f.article, f.range, f.doc)!.toString()).toBe('ﬃX');
  });
});
