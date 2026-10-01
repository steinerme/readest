import { describe, expect, it } from 'vitest';
import { reflowPdfText, type PdfTextItem } from '@/utils/pdfReflow';

const item = (
  str: string,
  x: number,
  y: number,
  size = 12,
  width = str.length * size * 0.5,
): PdfTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
  height: size,
});
const reflow = (items: PdfTextItem[]) => reflowPdfText(items, 600, 800);

describe('reflowPdfText', () => {
  it('orders raw PDF baselines top-down and fragments left-right without mutating input', () => {
    const items = [item('world', 88, 700), item('Next line.', 50, 684), item('Hello', 50, 700)];
    const snapshot = JSON.stringify(items);
    expect(reflow(items).blocks).toEqual([{ kind: 'paragraph', text: 'Hello world Next line.' }]);
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  it('joins CJK line wraps and Latin words with language-aware punctuation', () => {
    const result = reflow([
      item('中文', 50, 700),
      item('段落，', 76, 700),
      item('第二行。', 50, 684),
      item('Hello', 50, 640),
      item(',', 81, 640),
      item('world', 90, 640),
      item('again.', 50, 624),
    ]);
    expect(result.blocks).toEqual([
      { kind: 'paragraph', text: '中文段落，第二行。' },
      { kind: 'paragraph', text: 'Hello, world again.' },
    ]);
  });

  it('keeps split Latin glyphs together but honors real whitespace', () => {
    expect(
      reflow([item('read', 50, 700), item('ing ', 74, 700), item('text', 92, 700)]).blocks[0]?.text,
    ).toBe('reading text');
  });

  it('attaches small superscripts to the body baseline without creating notes', () => {
    expect(
      reflow([
        item('2', 62, 705, 7, 4),
        item('E=', 66, 700),
        item('x', 50, 700),
        item('A continued body sentence.', 50, 684),
      ]).blocks,
    ).toEqual([{ kind: 'paragraph', text: 'x2E= A continued body sentence.' }]);
  });

  it('uses transform font size rather than an anomalous italic glyph height', () => {
    const italic = item('Italic body text continues', 50, 700);
    italic.transform = [12, 0, 3, Math.sqrt(135), 50, 700];
    italic.height = 150;
    expect(reflow([italic, item('on another line.', 50, 684)]).blocks).toEqual([
      { kind: 'paragraph', text: 'Italic body text continues on another line.' },
    ]);
  });

  it('starts a new paragraph on a large baseline gap', () => {
    expect(
      reflow([
        item('First line', 50, 700),
        item('continues.', 50, 684),
        item('Next paragraph.', 50, 645),
      ]).blocks,
    ).toHaveLength(2);
  });

  it('preserves independent small-font notes and joins their wrapped lines', () => {
    expect(
      reflow([
        item('This is a sufficiently long body paragraph to establish body size.', 50, 700),
        item('Body continues on this second line.', 50, 684),
        item('1 Note text', 50, 100, 8),
        item('continued here.', 50, 89, 8),
      ]).blocks,
    ).toEqual([
      {
        kind: 'paragraph',
        text: 'This is a sufficiently long body paragraph to establish body size. Body continues on this second line.',
      },
      { kind: 'note', text: '1 Note text continued here.' },
    ]);
  });

  it('splits an independent small-font line even inside the page body', () => {
    const result = reflow([
      item('A full length normal body sentence precedes the note.', 50, 700),
      item('Small standalone note.', 50, 680, 8),
      item('Another full length body sentence follows the note.', 50, 660),
    ]);
    expect(result.blocks.map((block) => block.kind)).toEqual(['paragraph', 'note', 'paragraph']);
  });

  it('removes isolated pure numeric page numbers at both page edges', () => {
    const result = reflow([item('7', 295, 775), item('正文完整段落', 50, 700), item('8', 295, 25)]);
    expect(result.removedPageNumbers).toEqual(['7', '8']);
    expect(result.blocks).toEqual([{ kind: 'paragraph', text: '正文完整段落' }]);
  });

  it('preserves body years, margin years, and body-only numeric lines', () => {
    const result = reflow([
      item('2024', 280, 775),
      item('History in', 50, 700),
      item('2023', 50, 684),
      item('42', 50, 668),
      item('2025', 280, 25),
    ]);
    expect(result.removedPageNumbers).toEqual([]);
    for (const text of ['2024', '2023', '42', '2025']) {
      expect(result.blocks.some((block) => block.text.includes(text))).toBe(true);
    }
  });

  it('does not delete edge digits that are close to nearby text', () => {
    expect(reflow([item('A footer label', 50, 42), item('9', 50, 28)]).removedPageNumbers).toEqual(
      [],
    );
  });

  it('warns on empty or whitespace-only extraction', () => {
    expect(reflow([])).toEqual({ blocks: [], removedPageNumbers: [], warnings: ['empty-text'] });
    expect(reflow([item(' \n\t ', 50, 700)]).warnings).toContain('empty-text');
  });

  it('warns on repeated wide gaps suggesting multiple columns without losing text', () => {
    const result = reflow([
      item('Left A', 50, 700),
      item('Right A', 350, 700),
      item('Left B', 50, 684),
      item('Right B', 350, 684),
    ]);
    expect(result.warnings).toContain('possible-multiple-columns');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map((block) => block.text).join(' ')).toBe(
      'Left A Right A Left B Right B',
    );
  });

  it('warns once about rotation and retains unsupported rotated text separately', () => {
    const first = item('Rotated', 50, 700);
    first.transform = [0, 12, -12, 0, 50, 700];
    const second = item('Vertical', 100, 600);
    second.dir = 'ttb';
    const result = reflow([first, second]);
    expect(result.warnings).toEqual(['rotated-text']);
    expect(result.blocks.map((block) => block.text)).toEqual(['Rotated', 'Vertical']);
  });

  it('ignores hasEOL on fragments when geometry still places them on one line', () => {
    const first = item('Hello', 50, 700);
    first.hasEOL = true;
    expect(reflow([first, item('world', 88, 700)]).blocks[0]?.text).toBe('Hello world');
  });

  it('removes only soft wrap hyphens and preserves visible compound hyphens', () => {
    expect(reflow([item('inter\u00ad', 50, 700), item('national', 50, 684)]).blocks[0]?.text).toBe(
      'international',
    );
    expect(reflow([item('well-', 50, 700), item('known', 50, 684)]).blocks[0]?.text).toBe(
      'well-known',
    );
  });

  it('separates an indented paragraph from a preceding unindented line', () => {
    expect(
      reflow([item('Previous sentence.', 50, 700), item('New paragraph.', 74, 684)]).blocks,
    ).toHaveLength(2);
  });

  it('rejects invalid coordinates without corrupting valid text', () => {
    const broken = item('Broken', 50, 700);
    broken.transform[5] = NaN;
    expect(reflow([broken, item('Valid', 50, 684)])).toEqual({
      blocks: [{ kind: 'paragraph', text: 'Valid' }],
      removedPageNumbers: [],
      warnings: ['invalid-text-item'],
    });
  });
});
