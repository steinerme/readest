import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve(__dirname, '../../styles/pdf-reflow.css'), 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start));
};

describe('inline equation styling', () => {
  // Width, height and baseline offset are written in em. An element whose own
  // font-size is 0 makes every em 0, so the picture would have no size at all.
  it('never zeroes the font-size that the picture size is measured in', () => {
    const block = rule('.pdf-reflow-inline-equation');
    expect(block).not.toBe('');
    expect(block).not.toMatch(/font-size:\s*0(px|em|rem|%)?\s*;/);
  });
  it('is an inline box that sits on the text baseline', () => {
    const block = rule('.pdf-reflow-inline-equation');
    expect(block).toMatch(/display:\s*inline-block/);
  });
});
