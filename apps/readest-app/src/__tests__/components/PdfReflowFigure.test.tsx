import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const ink = vi.hoisted(() => ({ toInkMask: vi.fn() }));
vi.mock('@/utils/pdfReflowInk', () => ink);

import PdfReflowFigure from '@/app/reader/components/PdfReflowFigure';

const block = (bodySize?: number) =>
  ({
    kind: 'figure',
    text: '',
    figure: { x0: 300, y0: 500, x1: 500, y1: 600, ...(bodySize ? { bodySize } : {}) },
  }) as never;

const show = (bodySize?: number) =>
  render(
    <PdfReflowFigure
      index={0}
      block={block(bodySize)}
      page={0}
      pageWidth={600}
      pageHeight={800}
      fontSize={16}
      render={vi.fn(async () => 'blob:region')}
      label='Figure'
      failedLabel='failed'
    />,
  );

afterEach(() => ink.toInkMask.mockReset());

describe('PdfReflowFigure theme following', () => {
  // A typeset result box (lshort) is not an equation, but it is black ink on
  // white paper: in a dark theme it must not be a white sheet.
  it('paints a black-and-white picture in the text colour', async () => {
    ink.toInkMask.mockResolvedValue('blob:mask');
    const { container } = show();
    await waitFor(() => expect(container.querySelector('.pdf-reflow-ink')).toBeTruthy());
    expect(ink.toInkMask).toHaveBeenCalledWith('blob:region', { lineArtOnly: true });
    expect(container.querySelector('img')).toBeNull();
  });
  it('keeps the pixels of a picture that is not line art', async () => {
    ink.toInkMask.mockResolvedValue(null);
    const { container } = show();
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    expect(container.querySelector('img')!.getAttribute('src')).toBe('blob:region');
    expect(container.querySelector('.pdf-reflow-ink')).toBeNull();
  });
  it('always masks an equation picture', async () => {
    ink.toInkMask.mockResolvedValue('blob:mask');
    const { container } = show(10);
    await waitFor(() => expect(container.querySelector('.pdf-reflow-ink')).toBeTruthy());
    expect(ink.toInkMask).toHaveBeenCalledWith('blob:region', { lineArtOnly: false });
  });
});
