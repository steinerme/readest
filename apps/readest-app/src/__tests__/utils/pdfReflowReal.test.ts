// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { extractPdfGraphics } from '@/utils/pdfReflowGraphics';
import { PDF_FIXTURES } from '../fixtures/data/pdfReflowFixtures';
import { reflowPdfText, type PdfTextItem, type ReflowPage } from '@/utils/pdfReflow';

// Real pdf.js parsing of small generated PDFs (same library the app ships);
// fixtures/data/pdf-reflow/make_pdfs.py regenerates them with reportlab.
const root = path.resolve(__dirname, '../../../../../packages/foliate-js/node_modules/pdfjs-dist');

interface PdfJs {
  OPS: Record<string, number>;
  getDocument: (options: Record<string, unknown>) => {
    promise: Promise<{
      getPage: (n: number) => Promise<{
        view: number[];
        getTextContent: () => Promise<{ items: Array<Record<string, unknown>> }>;
        getOperatorList: () => Promise<{
          fnArray: ArrayLike<number>;
          argsArray: ArrayLike<unknown>;
        }>;
      }>;
    }>;
  };
}

async function reflow(name: string): Promise<ReflowPage> {
  const pdfjs = (await import(
    '../../../../../packages/foliate-js/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
  )) as unknown as PdfJs;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(Buffer.from(PDF_FIXTURES[name]!, 'base64')),
    useSystemFonts: true,
    disableFontFace: true,
    cMapUrl: `${root}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}/standard_fonts/`,
  }).promise;
  const page = await doc.getPage(1);
  const [x1, y1, x2, y2] = page.view as [number, number, number, number];
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  for (const item of content.items) {
    if (typeof item['str'] !== 'string') continue;
    const t = item['transform'] as number[];
    items.push({
      str: item['str'],
      width: item['width'] as number,
      height: item['height'] as number,
      transform: [...t.slice(0, 4), t[4]! - x1, t[5]! - y1],
      hasEOL: item['hasEOL'] as boolean,
      dir: item['dir'] as string,
    });
  }
  const list = await page.getOperatorList();
  const graphics = extractPdfGraphics(list, pdfjs.OPS, [x1, y1], x2 - x1, y2 - y1);
  return reflowPdfText(items, x2 - x1, y2 - y1, true, graphics);
}

const cellText = (page: ReflowPage) =>
  page.blocks
    .filter((b) => b.kind === 'cell')
    .map((b) => `${b.table!.row},${b.table!.col}=${b.text}`);

describe('reflow with real pdf.js operator lists', () => {
  it('rebuilds a ruled grid table in reading order between paragraphs', async () => {
    const page = await reflow('ruled');
    const kinds = page.blocks.map((b) => b.kind);
    expect(kinds[0]).toBe('paragraph');
    expect(kinds.filter((k) => k === 'cell')).toHaveLength(16);
    expect(cellText(page).slice(0, 5)).toEqual([
      '0,0=Region',
      '0,1=Q1',
      '0,2=Q2',
      '0,3=Q3',
      '1,0=North',
    ]);
    const first = page.blocks.find((b) => b.kind === 'cell')!;
    expect(first.table).toMatchObject({ header: true, rows: 4, cols: 4 });
    expect(page.blocks.find((b) => b.text === '1,200')!.table!.numeric).toBe(true);
    // paragraph after the table and the figure after that, in order
    const order = kinds.join(',');
    expect(order.indexOf('cell')).toBeGreaterThan(order.indexOf('paragraph'));
    expect(kinds.lastIndexOf('figure')).toBeGreaterThan(kinds.lastIndexOf('cell'));
    expect(page.blocks.some((b) => b.text.startsWith('Table 1 shows'))).toBe(true);
    // The caption under the image stays as text.
    expect(page.blocks.some((b) => b.text.startsWith('Figure 1'))).toBe(true);
  });

  it('keeps bitmap placement as a figure with sane geometry', async () => {
    const page = await reflow('ruled');
    const figure = page.blocks.find((b) => b.kind === 'figure')!;
    expect(figure.figure!.x1 - figure.figure!.x0).toBeCloseTo(300, -1);
    expect(figure.figure!.y1 - figure.figure!.y0).toBeCloseTo(180, -1);
    expect(page.pageWidth).toBeGreaterThan(500);
  });

  it('recognises a three-rule (booktabs) table with a header', async () => {
    const page = await reflow('booktabs');
    expect(cellText(page)).toContain('0,0=Method');
    expect(cellText(page)).toContain('2,2=85.1');
    expect(page.blocks.find((b) => b.text === 'Method')!.table!.header).toBe(true);
    expect(page.blocks.some((b) => b.text.startsWith('Results favour'))).toBe(true);
  });

  it('recognises a rule-less aligned CJK table', async () => {
    const page = await reflow('plain');
    expect(cellText(page)).toContain('0,1=成本(万元)');
    expect(cellText(page)).toContain('3,3=高');
    expect(page.blocks.filter((b) => b.kind === 'paragraph')).toHaveLength(2);
  });

  it('turns a vector chart into a figure and drops its axis labels from the flow', async () => {
    const page = await reflow('chart');
    const figures = page.blocks.filter((b) => b.kind === 'figure');
    expect(figures).toHaveLength(1);
    const text = page.blocks.map((b) => b.text).join(' ');
    expect(text).not.toContain('Jan');
    expect(text).toContain('Figure 2');
  });

  it('leaves plain prose and a framed call-out untouched', async () => {
    const page = await reflow('prose');
    expect(page.blocks.every((b) => b.kind === 'paragraph')).toBe(true);
    expect(page.blocks.some((b) => b.text.includes('framed call-out'))).toBe(true);
  });
});
