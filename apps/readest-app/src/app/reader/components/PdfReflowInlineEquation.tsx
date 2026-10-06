import { useEffect, useState } from 'react';
import { INLINE_EQUATION_MARK, type InlineEquation } from '@/utils/pdfReflowInline';

interface Props {
  equation: InlineEquation;
  page: number;
  render?: (
    rect: { x0: number; y0: number; x1: number; y1: number },
    maxWidth?: number,
  ) => Promise<string | null>;
  label: string;
}

/** A small picture of one inline equation. It reserves its final size before
 * the bitmap exists so the line never jumps, carries no text, and sits on the
 * text baseline. The size is `region / body size` em, i.e. the same scale as
 * the surrounding characters. */
const PdfReflowInlineEquation = ({ equation, page, render, label }: Props) => {
  const [src, setSrc] = useState<string | null>(null);
  const width = (equation.x1 - equation.x0) / equation.bodySize;
  const height = (equation.y1 - equation.y0) / equation.bodySize;

  useEffect(() => {
    if (!render) return;
    let current = true;
    let url: string | null = null;
    render(
      { x0: equation.x0, y0: equation.y0, x1: equation.x1, y1: equation.y1 },
      // Sharp enough for a 1.25x mobile reading size on a 3x display.
      Math.min(900, Math.max(160, width * 56 * 3)),
    )
      .then((value) => {
        if (!current) {
          if (value) URL.revokeObjectURL(value);
          return;
        }
        url = value;
        if (value) setSrc(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [equation, page, render, width]);

  return (
    <span
      className='pdf-reflow-inline-equation'
      role='img'
      aria-label={label}
      data-reflow-inline-equation=''
      style={{
        width: `${width.toFixed(3)}em`,
        height: `${height.toFixed(3)}em`,
        verticalAlign: `${(-equation.descent).toFixed(3)}em`,
      }}
    >
      {/* Nothing here is in normal flow: an inline-block with no in-flow
          content has its bottom edge as its baseline, which is what the
          vertical-align offset above is measured from. The zero-width marker
          stays in the DOM so block text offsets used by speech highlights and
          selection mapping are unchanged. */}
      <span className='pdf-reflow-inline-equation-mark'>{INLINE_EQUATION_MARK}</span>
      {src && <img src={src} alt='' draggable={false} decoding='async' />}
    </span>
  );
};

export default PdfReflowInlineEquation;
