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
  it('splits a numbered item glued to Chinese text after a finished sentence', () => {
    expect(startsListItem('6.假设你要设计一个智能体', '优势？')).toBe(true);
    expect(startsListItem('6.假设你要设计一个智能体', '他们又有哪些改进和优势')).toBe(false);
    expect(startsListItem('3.2节介绍了方法', '见上文。')).toBe(false);
    expect(startsListItem('2.5倍的速度', '见上文。')).toBe(false);
    expect(startsListItem('1.5Gb 的显存', '见上文。')).toBe(false);
  });
  it('keeps CJK numbered markers working', () => {
    expect(startsListItem('（2）第二点', '（1）第一点')).toBe(true);
    expect(startsListItem('2、第二点', '第一点。')).toBe(true);
  });
});

describe('lettered notes and centred lines', () => {
  it('starts a lettered note after a finished sentence or at a hanging marker', () => {
    expect(startsListItem('(b) The radian is the coherent unit.', 'It may not be possible.')).toBe(true);
    expect(startsListItem('(iv) the fourth clause', 'See the third.')).toBe(true);
    // The marker hangs out to the left of the wrapped line above it.
    expect(startsListItem('(c) The steradian', 'abolished in 1995', true)).toBe(true);
  });
  it('keeps a lettered reference inside a sentence', () => {
    expect(startsListItem('(b) shows the result', 'as can be seen in table', false)).toBe(false);
    expect(startsListItem('(a)', 'see part', false)).toBe(false);
    expect(startsListItem('(abc) text', 'It ended.', false)).toBe(false);
  });
  const named = (str: string, x: number, y: number, size: number, width: number, id: string) =>
    ({ ...item(str, x, y, size), width, fontName: id }) as PdfTextItem;
  // pdf.js font ids resolve to real names through the graphics' font table.
  const withFonts = { images: [], segments: [], shapes: [], fills: [], fonts: { F1: 'Times-Bold', F2: 'Times-Roman', F3: 'Courier' } };
  it('separates centred author, affiliation and address lines of different fonts', () => {
    // Geometry of the BERT title block: the three lines are centred on one
    // axis (x 297) with a line distance of 14 at size 12.
    const page = reflowPdfText(
      [
        named('Jacob Devlin Ming-Wei Chang Kenton Lee Kristina Toutanova', 122, 702, 12, 355, 'F1'),
        named('Google AI Language', 247, 688, 12, 101, 'F2'),
        named('{jacobdevlin,mingweichang,kentonl,kristout}@google.com', 108, 674, 12, 385, 'F3'),
        named('Abstract text that follows below the block at the margin.', 72, 600, 12, 330, 'F2'),
      ],
      600,
      800,
      false,
      withFonts,
    );
    expect(page.blocks.map((b) => b.text)).toEqual([
      'Jacob Devlin Ming-Wei Chang Kenton Lee Kristina Toutanova',
      'Google AI Language',
      '{jacobdevlin,mingweichang,kentonl,kristout}@google.com',
      'Abstract text that follows below the block at the margin.',
    ]);
  });
  it('keeps a centred title that wraps in one font as one block', () => {
    const page = reflowPdfText(
      [
        // Same geometry as the BERT title: the second line is centred and
        // only a little shorter than the first.
        named('A Title That Runs Over Two', 150, 760, 14, 300, 'F1'),
        named('Lines Of Text', 195, 744, 14, 210, 'F1'),
        // Body text at the page's left edge, as on a real page, so the title
        // is not itself taken for an indented line.
        named('Body text starts at the left margin of the page.', 72, 600, 14, 300, 'F2'),
      ],
      600,
      800,
      false,
      withFonts,
    );
    expect(page.blocks.map((b) => b.text)).toEqual([
      'A Title That Runs Over Two Lines Of Text',
      'Body text starts at the left margin of the page.',
    ]);
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
