import { describe, expect, it } from 'vitest';
import { reflowPdfText, startsListItem, type PdfTextItem } from '@/utils/pdfReflow';

const item = (str: string, x: number, y: number, size = 12, tilt = 0): PdfTextItem => ({
  str,
  width: str.length * size * 0.5,
  height: size,
  transform: [
    size * Math.cos(tilt),
    size * Math.sin(tilt),
    -size * Math.sin(tilt),
    size * Math.cos(tilt),
    x,
    y,
  ],
});

describe('startsListItem', () => {
  it('always splits at bullets and dash markers', () => {
    expect(startsListItem('• first', 'intro text')).toBe(true);
    expect(startsListItem('- first', 'intro text')).toBe(true);
    expect(startsListItem('— first', undefined)).toBe(true);
  });
  it('does not treat a hyphenated word or a bare dash as a bullet', () => {
    expect(startsListItem('-3 degrees', 'it was')).toBe(false);
    expect(startsListItem('well-known fact', 'a')).toBe(false);
  });
  it('splits numbered items only after a finished sentence or another item', () => {
    expect(startsListItem('2. Measure.', 'Weigh the sample.')).toBe(true);
    expect(startsListItem('2. Measure.', '1. Weigh the sample')).toBe(true);
    expect(startsListItem('2) the result', 'in the year 2020')).toBe(false);
    expect(startsListItem('3. next', undefined)).toBe(false);
  });
  it('keeps CJK numbered markers working', () => {
    expect(startsListItem('（2）第二点', '（1）第一点')).toBe(true);
    expect(startsListItem('2、第二点', '第一点。')).toBe(true);
  });
});

describe('reflow list and watermark rules', () => {
  const body = [
    item('This paragraph is ordinary reading text that wraps onto a second line', 50, 700),
    item('and keeps going well past the first line of the page body here.', 50, 686),
    item('Another sentence that is long enough to count as upright body text.', 50, 672),
  ];

  it('keeps wrapped prose in one block even when a line starts with a year-like number', () => {
    const page = reflowPdfText(
      [
        item('The study was repeated several times in the laboratory during', 50, 700),
        item('2020) and produced the same ordinary result every single time.', 50, 686),
      ],
      600,
      800,
    );
    expect(page.blocks).toHaveLength(1);
  });

  it('drops a short diagonal stamp on a text page and reports it', () => {
    const page = reflowPdfText([...body, item('DRAFT', 200, 300, 48, 0.6)], 600, 800);
    expect(page.blocks.some((b) => b.text.includes('DRAFT'))).toBe(false);
    expect(page.warnings).toContain('watermark-text-dropped');
  });

  it('keeps diagonal text when the page has little upright text', () => {
    const page = reflowPdfText(
      [item('Mostly tilted page content here', 100, 300, 24, 0.6)],
      600,
      800,
    );
    expect(page.blocks.some((b) => b.text.includes('tilted'))).toBe(true);
    expect(page.warnings).not.toContain('watermark-text-dropped');
  });

  it('keeps a quarter-turn sidebar (not diagonal)', () => {
    const page = reflowPdfText(
      [...body, item('Journal of Things', 20, 400, 10, Math.PI / 2)],
      600,
      800,
    );
    expect(page.warnings).not.toContain('watermark-text-dropped');
  });
});

describe('vector bullet discs', () => {
  const graphics = (shapes: Array<[number, number, number, number]>) => ({
    images: [],
    segments: [],
    fills: [],
    shapes: shapes.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 })),
  });
  const page = () => [
    item('Intro sentence.', 72, 700),
    item('first point that wraps', 93, 680),
    item('onto a second row', 93, 665),
    item('second point', 93, 645),
  ];

  it('starts a new block at a line with a small disc just left of it', () => {
    const g = graphics([
      [82, 681, 85.5, 684.5],
      [82, 646, 85.5, 649.5],
    ]);
    const blocks = reflowPdfText(page(), 612, 792, false, g).blocks.map((b) => b.text);
    expect(blocks).toEqual([
      'Intro sentence.',
      'first point that wraps onto a second row',
      'second point',
    ]);
  });
  it('keeps the old merge without discs, and ignores large or distant shapes', () => {
    const none = reflowPdfText(page(), 612, 792, false, graphics([])).blocks;
    const big = graphics([
      [82, 681, 112, 711],
      [300, 646, 303.5, 649.5],
    ]);
    const other = reflowPdfText(page(), 612, 792, false, big).blocks;
    expect(other.map((b) => b.text)).toEqual(none.map((b) => b.text));
  });
});
