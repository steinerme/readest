import { describe, expect, it } from 'vitest';
import { reflowPdfText, type PdfTextItem } from '@/utils/pdfReflow';
import { mapPdfSpeechRange } from '@/utils/pdfReflowTTS';

const item = (str: string, x = 50, y = 700): PdfTextItem => ({
  str,
  transform: [14, 0, 0, 14, x, y],
  width: str.length * 7,
  height: 14,
});
function fixture(items: PdfTextItem[]) {
  const page = reflowPdfText(items, 612, 792, true);
  const doc = document.implementation.createHTMLDocument('');
  const layer = doc.createElement('div');
  layer.className = 'textLayer';
  doc.body.append(layer);
  const nodes = items.map((item) => {
    const span = doc.createElement('span');
    span.textContent = item.str;
    layer.append(span);
    return span.firstChild!;
  });
  const range = (
    start: number,
    from: number,
    end = start,
    to = nodes[end]!.textContent!.length,
  ) => {
    const range = doc.createRange();
    range.setStart(nodes[start]!, from);
    range.setEnd(nodes[end]!, to);
    return range;
  };
  return { page, doc, range };
}
const markedText = (f: ReturnType<typeof fixture>, range: Range) =>
  mapPdfSpeechRange(f.page, range).map((h) => f.page.blocks[h.block]!.text.slice(h.start, h.end));

describe('PDF speech Range provenance', () => {
  it('identifies the second identical sentence by Range offsets, never the first match', () => {
    const f = fixture([item('Same sentence.', 50, 700), item('Same sentence.', 50, 650)]);
    expect(mapPdfSpeechRange(f.page, f.range(1, 0))).toEqual([{ block: 1, start: 0, end: 14 }]);
  });
  it('tracks visual reordering while retaining original PDF extraction order', () => {
    const f = fixture([item('Second.', 50, 650), item('First.', 50, 700)]);
    expect(mapPdfSpeechRange(f.page, f.range(0, 0))).toEqual([{ block: 1, start: 0, end: 7 }]);
  });
  it('maps exact word boundaries without synthesizing fake per-character timestamps', () => {
    const f = fixture([item('Hello world.')]);
    expect(markedText(f, f.range(0, 6, 0, 11))).toEqual(['world']);
  });
  it('maps a sentence across wrapped runs, injected spaces and soft hyphens', () => {
    const f = fixture([item('inter\u00ad', 50, 700), item('national text.', 50, 682)]);
    expect(f.page.blocks[0]!.text).toBe('international text.');
    expect(markedText(f, f.range(0, 0, 1))).toEqual(['international text.']);
    const spaces = fixture([item('Hello', 50), item('world.', 95)]);
    expect(markedText(spaces, spaces.range(0, 0, 1))).toEqual(['Hello world.']);
  });
  it('normalizes compatibility glyphs and whitespace consistently', () => {
    const f = fixture([item('ﬁne  中文。')]);
    expect(markedText(f, f.range(0, 0))).toEqual(['ﬁne 中文。']);
  });
  it('does not highlight a removed footer page number', () => {
    const f = fixture([item('Body.', 50, 700), item('7', 300, 24)]);
    expect(markedText(f, f.range(1, 0))).toEqual([]);
    expect(markedText(f, f.range(0, 0))).toEqual(['Body.']);
  });
  it('refuses mismatched transformed documents, foreign ranges, collapsed ranges and missing maps', () => {
    const f = fixture([item('Original.')]);
    const r = f.range(0, 0);
    f.doc.querySelector('.textLayer')!.append('Modified.');
    expect(mapPdfSpeechRange(f.page, r)).toEqual([]);
    const other = fixture([item('Other.')]);
    expect(mapPdfSpeechRange(f.page, other.range(0, 0))).toEqual([]);
    expect(mapPdfSpeechRange(other.page, other.range(0, 0, 0, 0))).toEqual([]);
    expect(mapPdfSpeechRange({ blocks: [], warnings: [], removedPageNumbers: [] }, r)).toEqual([]);
  });
  it('maps Range boundaries on elements as well as text nodes', () => {
    const f = fixture([item('First.'), item('Second.', 50, 650)]);
    const r = f.doc.createRange();
    const layer = f.doc.querySelector('.textLayer')!;
    r.setStart(layer, 1);
    r.setEnd(layer, 2);
    expect(markedText(f, r)).toEqual(['Second.']);
  });
});
