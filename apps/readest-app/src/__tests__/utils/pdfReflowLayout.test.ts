import { describe, expect, it } from 'vitest';
import { extractPdfGraphics, type PdfGraphics } from '@/utils/pdfReflowGraphics';
import { reflowPdfText, type PdfTextItem } from '@/utils/pdfReflow';
import { groupReflowBlocks } from '@/utils/pdfReflowGroups';

const item = (str: string, x: number, y: number, size = 12): PdfTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: str.length * size * 0.5,
  height: size,
});
const empty: PdfGraphics = { images: [], segments: [], shapes: [], fills: [] };
const hline = (y: number, x0: number, x1: number) => ({ x0, y0: y, x1, y1: y });
const vline = (x: number, y0: number, y1: number) => ({ x0: x, y0, x1: x, y1 });
const run = (items: PdfTextItem[], graphics: Partial<PdfGraphics> = {}) =>
  reflowPdfText(items, 600, 800, true, { ...empty, ...graphics });

describe('extractPdfGraphics', () => {
  const OPS = {
    save: 10,
    restore: 11,
    transform: 12,
    constructPath: 91,
    stroke: 20,
    fill: 22,
    paintImageXObject: 85,
    paintFormXObjectBegin: 74,
    paintFormXObjectEnd: 75,
  };
  it('applies nested transforms to image placements and subtracts the view origin', () => {
    const list = {
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [null, [200, 0, 0, 100, 50, 300], ['img'], null],
    };
    const result = extractPdfGraphics(list, OPS, [10, 20], 600, 800);
    expect(result.images).toEqual([{ x0: 40, y0: 280, x1: 240, y1: 380 }]);
  });
  it('turns stroked axis-aligned paths into rules and curved paths into shapes', () => {
    const path = new Float32Array([
      0, 100, 100, 1, 300, 100, 0, 100, 200, 2, 120, 260, 150, 260, 200, 200,
    ]);
    const list = {
      fnArray: [OPS.constructPath],
      argsArray: [[OPS.stroke, [path], null]],
    };
    const result = extractPdfGraphics(list, OPS, [0, 0], 600, 800);
    expect(result.segments).toEqual([{ x0: 100, y0: 100, x1: 300, y1: 100 }]);
    expect(result.shapes).toHaveLength(1);
  });
  it('never throws on malformed lists', () => {
    const result = extractPdfGraphics(
      { fnArray: [OPS.constructPath, OPS.transform], argsArray: [null, [NaN]] },
      OPS,
      [0, 0],
      600,
      800,
    );
    expect(result).toEqual(empty);
  });
});

describe('table recognition', () => {
  const grid = (): Partial<PdfGraphics> => {
    const ys = [700, 676, 652];
    const xs = [60, 200, 300];
    return {
      segments: [...ys.map((y) => hline(y, 60, 300)), ...xs.map((x) => vline(x, 652, 700))],
    };
  };
  it('builds a ruled table with header, rows and columns', () => {
    const page = run(
      [item('Name', 66, 683), item('Qty', 206, 683), item('Apple', 66, 659), item('12', 206, 659)],
      grid(),
    );
    const cells = page.blocks.filter((b) => b.kind === 'cell');
    expect(cells.map((c) => c.text)).toEqual(['Name', 'Qty', 'Apple', '12']);
    expect(cells[0]!.table).toMatchObject({ header: true, rows: 2, cols: 2, row: 0, col: 0 });
    expect(cells[3]!.table!.numeric).toBe(true);
    expect(page.sourceMap).toHaveLength(page.blocks.length);
  });
  it('keeps source offsets of cell text for speech and selection mapping', () => {
    const page = run(
      [item('Name', 66, 683), item('Qty', 206, 683), item('Apple', 66, 659), item('12', 206, 659)],
      grid(),
    );
    expect(page.sourceText).toBe('NameQtyApple12');
    expect(page.sourceMap![0]).toEqual([0, 1, 2, 3]);
    expect(page.sourceMap![3]).toEqual([12, 13]);
  });
  it('does not treat a single framed box as a table', () => {
    const page = run([item('Careful: read this', 70, 683)], {
      segments: [
        hline(700, 60, 300),
        hline(670, 60, 300),
        vline(60, 670, 700),
        vline(300, 670, 700),
      ],
    });
    expect(page.blocks.every((b) => b.kind === 'paragraph')).toBe(true);
  });
  it('groups cells by table and row for rendering without losing indices', () => {
    const page = run(
      [
        item('Intro paragraph text here', 60, 760),
        item('Name', 66, 683),
        item('Qty', 206, 683),
        item('Apple', 66, 659),
        item('12', 206, 659),
      ],
      grid(),
    );
    const groups = groupReflowBlocks(page.blocks);
    expect(groups[0]!.type).toBe('block');
    const table = groups.find((g) => g.type === 'table');
    expect(table && table.type === 'table' && table.rows.map((r) => r.cells.length)).toEqual([
      2, 2,
    ]);
    if (table?.type === 'table')
      expect(table.rows.flatMap((r) => r.cells.map((c) => c.index))).toEqual([1, 2, 3, 4]);
  });
  it('recognises a rule-less aligned table but leaves a two-column prose line alone', () => {
    const table = run([
      item('Item', 60, 700),
      item('Cost', 200, 700),
      item('Days', 320, 700),
      item('A', 60, 682),
      item('120', 200, 682),
      item('45', 320, 682),
      item('B', 60, 664),
      item('98', 200, 664),
      item('60', 320, 664),
    ]);
    expect(table.blocks.filter((b) => b.kind === 'cell')).toHaveLength(9);
    const prose = run([
      item('This is an ordinary sentence that wraps over', 60, 700),
      item('two lines of running text in the body copy.', 60, 684),
    ]);
    expect(prose.blocks.map((b) => b.kind)).toEqual(['paragraph']);
  });
});

describe('figure recognition', () => {
  it('emits a figure block for a bitmap in reading order and keeps captions as text', () => {
    const page = run(
      [item('Before the picture, a sentence.', 60, 760), item('Figure 1: caption', 60, 420)],
      { images: [{ x0: 100, y0: 450, x1: 400, y1: 700 }] },
    );
    expect(page.blocks.map((b) => b.kind)).toEqual(['paragraph', 'figure', 'paragraph']);
    // A 2pt safety margin avoids clipping anti-aliased edges.
    expect(page.blocks[1]!.figure).toEqual({ x0: 98, y0: 448, x1: 402, y1: 702 });
    expect(page.pageWidth).toBe(600);
  });
  it('ignores tiny decorations and full-page backgrounds', () => {
    const page = run([item('Body text', 60, 700)], {
      images: [
        { x0: 0, y0: 0, x1: 600, y1: 800 },
        { x0: 300, y0: 300, x1: 310, y1: 308 },
      ],
    });
    expect(page.blocks.map((b) => b.kind)).toEqual(['paragraph']);
  });
  it('does not turn an inline glyph image into a figure', () => {
    const page = run([item('Inline icon here', 60, 700)], {
      images: [{ x0: 120, y0: 698, x1: 132, y1: 710 }],
    });
    expect(page.blocks.map((b) => b.kind)).toEqual(['paragraph']);
  });
});
