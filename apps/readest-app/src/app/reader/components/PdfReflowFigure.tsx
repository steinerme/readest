import { useEffect, useRef, useState } from 'react';
import type { ReflowBlock } from '@/utils/pdfReflow';
import { toInkMask } from '@/utils/pdfReflowInk';

interface Props {
  index: number;
  block: ReflowBlock;
  page: number;
  pageWidth?: number;
  pageHeight?: number;
  /** Reading font size in CSS px; lets an equation picture match the text. */
  fontSize?: number;
  render?: (
    rect: { x0: number; y0: number; x1: number; y1: number },
    maxWidth?: number,
  ) => Promise<string | null>;
  label: string;
  failedLabel: string;
}

/** A picture region of the PDF page, rendered lazily and only when it nears
 * the viewport. The bitmap is a derived view of the page: it carries no text
 * and never takes part in speech, selection or annotation mapping. */
const PdfReflowFigure = ({
  index,
  block,
  page,
  pageWidth,
  pageHeight,
  fontSize,
  render,
  label,
  failedLabel,
}: Props) => {
  const ref = useRef<HTMLElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [mask, setMask] = useState(false);
  const [failed, setFailed] = useState(false);
  const [near, setNear] = useState(false);
  const rect = block.figure;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && setNear(true),
      { rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near || !rect || !render) return;
    let current = true;
    let url: string | null = null;
    setFailed(false);
    // Equations are ink on paper: show them as a mask painted in the text
    // colour so they follow the theme. Other pictures get the same treatment
    // only when they turn out to be black-and-white line art; photos and
    // colour charts keep their pixels.
    const equation = !!(rect.bodySize && rect.bodySize > 0);
    render(rect, 1100)
      .then(async (value) => {
        if (!current) {
          if (value) URL.revokeObjectURL(value);
          return;
        }
        if (!value) {
          setFailed(true);
          return;
        }
        const ink = await toInkMask(value, { lineArtOnly: !equation }).catch(() => null);
        if (!current) {
          URL.revokeObjectURL(ink ?? value);
          if (ink) URL.revokeObjectURL(value);
          return;
        }
        if (ink) URL.revokeObjectURL(value);
        url = ink ?? value;
        setMask(!!ink);
        setSrc(url);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [near, rect, render, page]);

  if (!rect) return null;
  const ratio = (rect.y1 - rect.y0) / Math.max(1, rect.x1 - rect.x0);
  const widthShare = pageWidth ? Math.min(1, (rect.x1 - rect.x0) / pageWidth) : 1;
  // An equation picture is scaled so its symbols are as tall as the reading
  // text: width = (region width / PDF body size) em. It never exceeds the column.
  const equationEm =
    rect.bodySize && rect.bodySize > 0 && fontSize ? (rect.x1 - rect.x0) / rect.bodySize : 0;
  return (
    <figure
      ref={ref}
      className='pdf-reflow-figure'
      data-reflow-figure={index}
      data-reflow-equation={equationEm ? '' : undefined}
      style={
        equationEm
          ? { width: `${equationEm.toFixed(2)}em`, maxWidth: '100%' }
          : { width: `${Math.max(30, Math.round(widthShare * 100))}%`, maxWidth: '100%' }
      }
    >
      {src && mask ? (
        <span
          className='pdf-reflow-ink'
          role='img'
          aria-label={`${label} ${index + 1}`}
          style={{
            WebkitMaskImage: `url(${src})`,
            maskImage: `url(${src})`,
            aspectRatio: `${1 / Math.max(0.01, ratio)}`,
          }}
        />
      ) : src ? (
        <img src={src} alt={`${label} ${index + 1}`} draggable={false} decoding='async' />
      ) : failed ? (
        <div className='pdf-reflow-figure-failed' role='note'>
          {failedLabel}
        </div>
      ) : (
        <div
          className='pdf-reflow-figure-skeleton'
          aria-hidden='true'
          style={{
            aspectRatio: `${1 / Math.max(0.05, Math.min(ratio, 3))}`,
            minHeight: pageHeight ? undefined : 80,
          }}
        />
      )}
    </figure>
  );
};

export default PdfReflowFigure;
