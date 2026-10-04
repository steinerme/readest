import { useEffect, useRef, useState } from 'react';
import type { ReflowBlock } from '@/utils/pdfReflow';

interface Props {
  index: number;
  block: ReflowBlock;
  page: number;
  pageWidth?: number;
  pageHeight?: number;
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
  render,
  label,
  failedLabel,
}: Props) => {
  const ref = useRef<HTMLElement>(null);
  const [src, setSrc] = useState<string | null>(null);
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
    render(rect, 1100)
      .then((value) => {
        if (!current) {
          if (value) URL.revokeObjectURL(value);
          return;
        }
        url = value;
        if (value) setSrc(value);
        else setFailed(true);
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
  return (
    <figure
      ref={ref}
      className='pdf-reflow-figure'
      data-reflow-figure={index}
      style={{ width: `${Math.max(30, Math.round(widthShare * 100))}%`, maxWidth: '100%' }}
    >
      {src ? (
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
