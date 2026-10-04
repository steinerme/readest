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

describe('sparse tables with mixed-size cells (real book page geometry)', () => {
  // Coordinates copied from a Chinese popular-science PDF: 8pt labels sit
  // beside 22pt/17pt figures printed vertically centred in each row.
  const sized = (str: string, x: number, y: number, size: number, width?: number): PdfTextItem => ({
    str,
    transform: [size, 0, 0, size, x, y],
    width: width ?? str.length * size,
    height: size,
  });
  const body = (str: string, y: number) => sized(str, 65, y, 13.5, 482);
  const page128 = [
    sized('总表面积（6面）', 103, 709, 10.1, 78),
    sized('6', 185, 688, 22.5, 11),
    sized(' ', 196, 688, 22.5, 81),
    sized('24', 257, 695, 17.4, 18),
    sized('体积（边长）', 103, 632, 10.1, 63),
    sized('3', 166, 636, 10.1, 5),
    sized('1', 185, 615, 22.5, 11),
    sized(' ', 196, 615, 22.5, 134),
    sized('8（重', 297, 636, 10.1, 26),
    sized('量）', 297, 623, 10.1, 21),
    sized('总表面积与体积', 103, 564, 10.1, 73),
    sized('比', 103, 551, 10.1, 10),
    sized('6', 185, 542, 22.5, 11),
    sized('3', 257, 549, 17.4, 9),
    body('正如以上所看到的，大方块冰单位体积所占的表面积要小于八个小方块。', 459),
    body('总面积即正方体冰块六个表面所有的面积。这表明八个立方体冰块的总表面积', 441),
  ];

  it('reads labels and large figures as one 3x3 table without a column warning', () => {
    const result = reflowPdfText(page128, 612, 792, true, empty);
    expect(result.warnings).not.toContain('possible-multiple-columns');
    const cells = result.blocks.filter((b) => b.kind === 'cell');
    expect(cells.map((c) => c.text)).toEqual([
      '总表面积（6面）',
      '6',
      '24',
      '体积（边长）3',
      '1',
      '8（重量）',
      '总表面积与体积比',
      '6',
      '3',
    ]);
    expect(cells[0]!.table).toMatchObject({ rows: 3, cols: 3 });
    // Body text stays in the flow after the table.
    expect(result.blocks.filter((b) => b.kind === 'paragraph')).toHaveLength(1);
  });

  it('keeps the table caption out of the table and ignores padding spaces', () => {
    const items = [
      body('说明文字说明文字说明文字说明文字说明文字说明文字', 400),
      sized('表 1 大方块冰和小方块冰的数据变化', 76, 251, 10.1, 168),
      sized('小方块冰', 197, 237, 10.1, 41),
      sized(' ', 238, 237, 10.1, 58),
      sized('大方块冰', 282, 237, 10.1, 41),
      sized('边长', 103, 191, 10.1, 20),
      sized('1', 185, 170, 22.5, 11),
      sized('2', 257, 176, 17.4, 9),
      sized('横切面面积', 103, 119, 10.1, 52),
      sized('1', 185, 98, 22.5, 11),
      sized('4', 257, 104, 17.4, 9),
    ];
    const result = reflowPdfText(items, 612, 792, true, empty);
    const cells = result.blocks.filter((b) => b.kind === 'cell');
    expect(cells.map((c) => c.text)).toEqual([
      '',
      '小方块冰',
      '大方块冰',
      '边长',
      '1',
      '2',
      '横切面面积',
      '1',
      '4',
    ]);
    expect(result.blocks.some((b) => b.kind !== 'cell' && b.text.startsWith('表 1'))).toBe(true);
  });

  it('does not turn ordinary wrapped paragraphs into a table', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      body(`这是第${i}行正文文字，用来确认普通段落不会被误判为表格结构。`, 700 - i * 17),
    );
    const result = reflowPdfText(lines, 612, 792, true, empty);
    expect(result.blocks.some((b) => b.kind === 'cell')).toBe(false);
  });
});
