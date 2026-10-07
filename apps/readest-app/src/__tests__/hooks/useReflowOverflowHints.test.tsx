import { describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import {
  overflowEdges,
  useReflowOverflowHints,
} from '@/app/reader/hooks/useReflowOverflowHints';

describe('overflowEdges', () => {
  it('names the edges that hide content', () => {
    expect(overflowEdges(0, 300, 300)).toBe('none');
    expect(overflowEdges(0, 300, 300.6)).toBe('none');
    expect(overflowEdges(0, 300, 500)).toBe('end');
    expect(overflowEdges(100, 300, 500)).toBe('both');
    expect(overflowEdges(200, 300, 500)).toBe('start');
  });
});

const size = (element: HTMLElement, client: number, scroll: number, left = 0) => {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: client });
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scroll });
  element.scrollLeft = left;
};

function Page({ wide }: { wide: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useReflowOverflowHints(ref, wide, 16);
  return (
    <article ref={ref}>
      <pre
        className='pdf-reflow-code'
        ref={(el) => {
          if (el) size(el, 300, wide ? 600 : 300);
        }}
      >
        code
      </pre>
      <div
        className='pdf-reflow-table-wrap'
        ref={(el) => {
          if (el) size(el, 300, 300);
        }}
      >
        <table />
      </div>
    </article>
  );
}

describe('useReflowOverflowHints', () => {
  it('marks a cut-off code block and follows its sideways scroll', () => {
    const { container } = render(<Page wide />);
    const code = container.querySelector<HTMLElement>('.pdf-reflow-code')!;
    const table = container.querySelector<HTMLElement>('.pdf-reflow-table-wrap')!;
    expect(code.dataset['overflow']).toBe('end');
    expect(table.dataset['overflow']).toBe('none');
    code.scrollLeft = 300;
    fireEvent.scroll(code);
    expect(code.dataset['overflow']).toBe('start');
    code.scrollLeft = 120;
    fireEvent.scroll(code);
    expect(code.dataset['overflow']).toBe('both');
  });
});
