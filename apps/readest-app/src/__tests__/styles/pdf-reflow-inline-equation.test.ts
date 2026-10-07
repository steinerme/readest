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
  // An inline-block takes its baseline from its last in-flow line box. With a
  // marker character or an image in flow, the picture would sit a full box
  // above where `vertical-align: -descent` puts it. Keeping both out of flow
  // makes the bottom edge the baseline, so the offset means what it says.
  it('keeps the marker and the picture out of normal flow', () => {
    expect(rule('.pdf-reflow-inline-equation-mark')).toMatch(/position:\s*absolute/);
    expect(rule('.pdf-reflow-inline-equation img')).toMatch(/position:\s*absolute/);
  });
  // Code blocks carry real line breaks and leading spaces; a collapsing
  // white-space would fold a listing into one line.
  it('keeps code lines and indentation', () => {
    expect(rule('.pdf-reflow-code')).toMatch(/white-space:\s*pre(-wrap)?\s*;/);
  });
  // Equations painted through an ink mask take the reading text colour, so
  // they never show as white boxes in dark themes.
  it('paints equation ink in the text colour', () => {
    expect(rule('.pdf-reflow-ink')).toMatch(/background-color:\s*currentColor/);
  });
});
