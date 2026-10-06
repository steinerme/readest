import { describe, expect, it } from 'vitest';
import { reflowPdfText, type PdfTextItem } from '@/utils/pdfReflow';
import { INLINE_EQUATION_MARK } from '@/utils/pdfReflowInline';
import type { PdfGraphics } from '@/utils/pdfReflowGraphics';

const item = (str: string, x: number, y: number, size = 10): PdfTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: str.length * size,
  height: size,
});
const empty: PdfGraphics = { images: [], segments: [], shapes: [], fills: [] };
const shape = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
const run = (items: PdfTextItem[], shapes: PdfGraphics['shapes'] = []) =>
  reflowPdfText(items, 600, 800, true, { ...empty, shapes });
const M = INLINE_EQUATION_MARK;

describe('inline equations drawn as vector outlines', () => {
  // "其中" (72-92), a glyph cluster at 96-108, then "是总数" (112-142), all at y=700.
  const line = () => [item('其中', 72, 700), item('是总数', 112, 700)];
  const letter = [shape(96, 699, 104, 708), shape(104, 696, 107, 703)];

  it('marks the place of an equation between two words and keeps the words', () => {
    const page = run(line(), letter);
    expect(page.blocks).toHaveLength(1);
    const block = page.blocks[0]!;
    expect(block.text).toBe(`其中${M}是总数`);
    expect(block.inline).toHaveLength(1);
    expect(block.inline![0]!.bodySize).toBeCloseTo(10, 0);
  });
  it('keeps the source map aligned: the marker maps to nothing, words keep offsets', () => {
    const page = run(line(), letter);
    const block = page.blocks[0]!;
    const map = page.sourceMap![0]!;
    expect(map).toHaveLength(block.text.length);
    expect(map[block.text.indexOf(M)]).toBe(-1);
    expect(map[0]).toBe(0);
    expect(map[block.text.length - 1]).toBe(4);
  });
  it('leaves a line without equation shapes exactly as before', () => {
    const page = run(line());
    expect(page.blocks[0]!.text).toBe('其中是总数');
    expect(page.blocks[0]!.inline).toBeUndefined();
  });
  it('ignores shapes that are not text-sized (bullet dots, large drawings)', () => {
    const dot = run(line(), [shape(96, 701, 98, 703)]);
    expect(dot.blocks[0]!.inline).toBeUndefined();
    const big = run(line(), [shape(96, 650, 150, 760)]);
    expect(big.blocks[0]!.inline).toBeUndefined();
  });
  it('ignores a cluster far from any word or off the baseline', () => {
    const far = run(line(), [shape(300, 699, 312, 708), shape(312, 696, 316, 703)]);
    expect(far.blocks[0]!.inline).toBeUndefined();
    const below = run(line(), [shape(96, 600, 108, 612), shape(108, 598, 112, 606)]);
    expect(below.blocks[0]!.inline).toBeUndefined();
  });
  it('does not turn a left-margin disc into an equation (it is a bullet)', () => {
    const page = run(
      [item('first point', 93, 700), item('second point', 93, 680)],
      [shape(82, 700, 85.5, 703.5), shape(82, 680, 85.5, 683.5)],
    );
    expect(page.blocks.map((b) => b.text)).toEqual(['first point', 'second point']);
    expect(page.blocks.every((b) => !b.inline)).toBe(true);
  });
  it('keeps an equation after the last word', () => {
    const page = run(
      [item('其中', 72, 700)],
      [shape(96, 699, 104, 708), shape(104, 696, 107, 703)],
    );
    expect(page.blocks[0]!.text).toBe(`其中${M}`);
  });
  it('gives display-equation figures the page body size for text-scale display', () => {
    const glyphs = Array.from({ length: 8 }, (_, i) => shape(200 + i * 12, 650, 208 + i * 12, 660));
    const page = run(
      [item('The identity is:', 72, 700), item('and then we continue.', 72, 600)],
      glyphs,
    );
    const figure = page.blocks.find((b) => b.kind === 'figure')!;
    expect(figure.figure!.bodySize).toBeCloseTo(10, 0);
  });
});
