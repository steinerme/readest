import { describe, expect, it } from 'vitest';
import { inkMaskPixels, isLineArt } from '@/utils/pdfReflowInk';
import { fontClass, joinLineRuns, joinText, type Run } from '@/utils/pdfReflowLines';
import { findGutter, textBoxes } from '@/utils/pdfReflowRegions';
import { reflowPdfText, type PdfTextItem } from '@/utils/pdfReflow';
import type { PdfGraphics } from '@/utils/pdfReflowGraphics';

const run = (text: string, x: number, y: number, size = 10, extra: Partial<Run> = {}): Run => ({
  text,
  source: [],
  x,
  y,
  size,
  width: text.length * size * 0.5,
  rotated: false,
  ...extra,
});

describe('equation ink mask (theme-following equation pictures)', () => {
  it('turns paper transparent and ink opaque, whatever the ink colour', () => {
    const px = new Uint8ClampedArray([
      255,
      255,
      255,
      255, // paper
      0,
      0,
      0,
      255, // black ink
      40,
      40,
      200,
      255, // dark blue ink
      200,
      200,
      200,
      255, // faint grey (watermark / noise)
    ]);
    inkMaskPixels(px);
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(255);
    expect(px[11]).toBeGreaterThan(200);
    expect(px[15]).toBe(0);
    // Colour is dropped: the reader paints the mask with the text colour.
    expect([px[4], px[5], px[6], px[8], px[9], px[10]]).toEqual([0, 0, 0, 0, 0, 0]);
  });
  // lshort's typeset-output boxes are not marked as equations, yet they are
  // black ink on white paper: they must follow the theme too. Colour charts
  // and shaded diagrams keep their own pixels.
  it('treats black-and-white pictures as line art and coloured ones as not', () => {
    const picture = (paper: number, ink: number, coloured: number) => {
      const px: number[] = [];
      for (let i = 0; i < paper; i++) px.push(255, 255, 255, 255);
      for (let i = 0; i < ink; i++) px.push(20, 20, 20, 255);
      for (let i = 0; i < coloured; i++) px.push(230, 90, 90, 255);
      return new Uint8ClampedArray(px);
    };
    expect(isLineArt(picture(95, 5, 0))).toBe(true);
    expect(isLineArt(picture(90, 10, 0))).toBe(true);
    // Bar chart: a quarter of the pixels are red bars.
    expect(isLineArt(picture(70, 5, 25))).toBe(false);
    // Dense dark picture (photo-like): too little paper.
    expect(isLineArt(picture(50, 50, 0))).toBe(false);
    // Transparent pixels count as paper.
    expect(isLineArt(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]))).toBe(false);
    expect(isLineArt(new Uint8ClampedArray([]))).toBe(false);
  });
  it('keeps anti-aliased edges partly transparent', () => {
    const px = new Uint8ClampedArray([128, 128, 128, 255]);
    inkMaskPixels(px);
    expect(px[3]).toBeGreaterThan(0);
    expect(px[3]).toBeLessThan(255);
  });
});

describe('font classes', () => {
  it('recognises code, math and bold fonts from real PDF font names', () => {
    expect(fontClass('CMUTypewriter-Light')).toBe('mono');
    expect(fontClass('SFTT1000')).toBe('mono');
    expect(fontClass('LucidaConsole')).toBe('mono');
    expect(fontClass('NimbusMonL-Regu')).toBe('mono');
    expect(fontClass('CMMI10')).toBe('math');
    expect(fontClass('CMEX10')).toBe('math');
    expect(fontClass('Yhcmex')).toBe('math');
    expect(fontClass('SymbolMT')).toBe('math');
    expect(fontClass('TimesNewRomanPS-BoldMT')).toBe('bold');
    expect(fontClass('SimHei')).toBeUndefined();
    expect(fontClass('TimesNewRomanPSMT')).toBeUndefined();
    expect(fontClass('CMR10')).toBeUndefined();
  });
});

describe('scripts and hyphenation', () => {
  it('shows raised digits after a glyph as superscripts and keeps word spaces', () => {
    const runs = [
      run('kg m', 100, 700, 12),
      run('2', 124, 704, 8),
      run('s', 131, 700, 12),
      run('−2', 137, 704, 8),
    ];
    expect(joinLineRuns(runs, 12).text).toBe('kg m² s⁻²');
  });
  it('joins a typesetter hyphen but keeps a compound hyphen', () => {
    expect(joinText('representa-', 'tion model', true, true)).toBe('representation model');
    expect(joinText('well-', 'known', true, true)).toBe('well-known');
    expect(joinText('pre-', 'trained', true, true)).toBe('pre-trained');
  });
});

describe('two-column gutter', () => {
  const column = (x: number, top: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      run('lorem ipsum dolor sit amet consectetur', x, top - i * 12),
    );
  it('finds a gutter when both sides carry running text', () => {
    const runs = [...column(72, 700, 30), ...column(310, 694, 30)];
    const gutter = findGutter(runs, 595, 10);
    expect(gutter).not.toBeNull();
    expect(gutter!.x0).toBeGreaterThan(250);
    expect(gutter!.x1).toBeLessThan(311);
  });
  it('does not split a wide table of short numbers into columns', () => {
    const runs: Run[] = [];
    for (let r = 0; r < 30; r++)
      for (const x of [80, 160, 240, 330, 410, 490]) runs.push(run('123', x, 700 - r * 12));
    expect(findGutter(runs, 595, 10)).toBeNull();
  });
  it('does not split single-column prose', () => {
    expect(
      findGutter(
        column(72, 700, 40).map((r) => ({ ...r, width: 450 })),
        595,
        10,
      ),
    ).toBeNull();
  });
});

describe('text boxes', () => {
  const empty: PdfGraphics = { images: [], segments: [], shapes: [], fills: [] };
  it('finds a framed box holding text, not an empty frame', () => {
    const frame = [
      { x0: 100, y0: 600, x1: 300, y1: 600 },
      { x0: 100, y0: 700, x1: 300, y1: 700 },
      { x0: 100, y0: 600, x1: 100, y1: 700 },
      { x0: 300, y0: 600, x1: 300, y1: 700 },
    ];
    expect(
      textBoxes({ ...empty, segments: frame }, [run('code', 120, 650)], 595, 842, 10),
    ).toHaveLength(1);
    expect(
      textBoxes({ ...empty, segments: frame }, [run('code', 400, 650)], 595, 842, 10),
    ).toHaveLength(0);
  });
});

describe('reading order with boxes, columns and code', () => {
  const item = (str: string, x: number, y: number, fontName?: string): PdfTextItem => ({
    str,
    transform: [10, 0, 0, 10, x, y],
    width: str.length * 5,
    height: 10,
    ...(fontName ? { fontName } : {}),
  });
  const box = (x0: number, y0: number, x1: number, y1: number) => [
    { x0, y0, x1, y1: y0 },
    { x0, y0: y1, x1, y1 },
    { x0, y0, x1: x0, y1 },
    { x0: x1, y0, x1, y1 },
  ];
  it('reads a source box and the result box beside it separately', () => {
    const items = [
      item('\\textbf{A}', 110, 680, 'f1'),
      item('\\textbf{B}', 110, 668, 'f1'),
      item('Result A', 330, 680),
      item('Result B', 330, 668),
    ];
    const graphics: PdfGraphics = {
      images: [],
      shapes: [],
      fills: [],
      segments: [...box(100, 660, 300, 700), ...box(320, 660, 520, 700)],
      fonts: { f1: 'CMUTypewriter-Light' },
    };
    const page = reflowPdfText(items, 595, 842, false, graphics);
    expect(page.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['code', '\\textbf{A}\n\\textbf{B}'],
      ['paragraph', 'Result A Result B'],
    ]);
  });
  // Two stacked result boxes with a sentence between them, each box holding
  // typeset math and a short floating stroke, were merged with the sentence
  // into one drawing: the boxes showed twice (once inside the wrapper) and the
  // end of the sentence disappeared into the picture.
  it('shows stacked result boxes once and keeps the sentence between them', () => {
    const items = [
      item('\\frac{a}{b}', 110, 690, 'm'),
      item('Result one', 340, 690, 'cmr10'),
      item('x', 380, 686, 'cmmi'),
      item('Sentence start', 110, 640),
      item('and its tail.', 340, 640),
      item('\\sqrt{c}', 110, 600, 'm'),
      item('Result two', 340, 600, 'cmr10'),
      item('y', 380, 596, 'cmmi'),
    ];
    const stroke = (x0: number, y: number, x1: number) => ({ x0, y0: y, x1, y1: y });
    const graphics: PdfGraphics = {
      images: [],
      shapes: [],
      fills: [],
      segments: [
        ...box(320, 675, 520, 705),
        ...box(320, 585, 520, 615),
        stroke(430, 690, 440),
        stroke(430, 600, 440),
      ],
      fonts: { m: 'CMUTypewriter-Light', cmr10: 'CMR10', cmmi: 'CMMI10' },
    };
    const page = reflowPdfText(items, 595, 842, false, graphics);
    const figures = page.blocks.filter((b) => b.kind === 'figure').map((b) => b.figure!);
    // No picture contains another one.
    for (const a of figures)
      for (const b of figures)
        if (a !== b)
          expect(
            b.x0 >= a.x0 - 2 && b.x1 <= a.x1 + 2 && b.y0 >= a.y0 - 2 && b.y1 <= a.y1 + 2,
          ).toBe(false);
    expect(page.blocks.map((b) => b.text).join('|')).toContain('Sentence start and its tail.');
  });
  it('keeps code indentation relative to the listing', () => {
    const items = [
      item('def f(n):', 100, 700, 'm'),
      item('return n', 120, 688, 'm'),
      item('Some prose follows here.', 100, 660),
    ];
    const graphics: PdfGraphics = {
      images: [],
      shapes: [],
      fills: [],
      segments: [],
      fonts: { m: 'SFTT1000' },
    };
    const page = reflowPdfText(items, 595, 842, false, graphics);
    expect(page.blocks[0]).toEqual({ kind: 'code', text: 'def f(n):\n    return n' });
    expect(page.blocks[1]!.kind).toBe('paragraph');
  });
});
