import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  items: [
    {
      str: '正文',
      width: 30,
      height: 14,
      transform: [14, 0, 0, 14, 80, 700],
      hasEOL: true,
      dir: 'ltr',
    },
    { type: 'beginMarkedContent' },
  ],
  destroy: vi.fn(),
  render: vi.fn(),
  rotate: 0,
}));
vi.mock('@pdfjs/pdf.min.mjs', () => {
  class PDFDataRangeTransport {
    onDataRange = vi.fn();
  }
  (globalThis as unknown as { pdfjsLib: unknown }).pdfjsLib = {
    GlobalWorkerOptions: {},
    PDFDataRangeTransport,
    OPS: { save: 10, restore: 11 },
    getDocument: () => ({
      destroy: mocks.destroy,
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          view: [20, 30, 620, 830],
          get rotate() {
            return mocks.rotate;
          },
          getViewport: () => ({ width: 600, height: 800 }),
          getOperatorList: async () => ({
            fnArray: new Uint8Array([10, 11]),
            argsArray: [null, null],
          }),
          getTextContent: async () => ({ items: mocks.items }),
          render: mocks.render,
          cleanup: vi.fn(),
        }),
        getMetadata: async () => ({ info: {} }),
        getViewerPreferences: async () => null,
        getOutline: async () => null,
        getPageLabels: async () => null,
      }),
    }),
  };
  return {};
});

describe('PDF section reflow text API', () => {
  it('normalizes crop-box origin without rendering or modifying original items', async () => {
    const { makePDF } = await import('foliate-js/pdf.js');
    const book = (await makePDF({
      size: 1,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    })) as unknown as {
      sections: {
        getReflowText: () => Promise<{
          items: import('@/utils/pdfReflow').PdfTextItem[];
          width: number;
          height: number;
          rotation: number;
        }>;
      }[];
      destroy: () => void;
    };
    const before = JSON.stringify(mocks.items);
    const data = await book.sections[0]!.getReflowText();
    expect(data.width).toBe(600);
    expect(data.height).toBe(800);
    expect(data.rotation).toBe(0);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.transform).toEqual([14, 0, 0, 14, 60, 670]);
    expect(data.items[0]!.str).toBe('正文');
    expect(mocks.render).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.items)).toBe(before);
    book.destroy();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('exposes read-only operator geometry and the real OPS table without rendering', async () => {
    const { makePDF } = await import('foliate-js/pdf.js');
    const book = (await makePDF({
      size: 1,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    })) as unknown as {
      sections: { getReflowGraphics: () => Promise<Record<string, unknown>> }[];
    };
    mocks.render.mockClear();
    const graphics = await book.sections[0]!.getReflowGraphics();
    expect(graphics['ops']).toEqual({ save: 10, restore: 11 });
    expect(graphics['origin']).toEqual([20, 30]);
    expect(graphics['width']).toBe(600);
    expect(Array.from(graphics['fnArray'] as ArrayLike<number>)).toEqual([10, 11]);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('refuses to render a figure region on rotated pages', async () => {
    const { makePDF } = await import('foliate-js/pdf.js');
    const book = (await makePDF({
      size: 1,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    })) as unknown as {
      sections: {
        renderReflowRegion: (r: object, w?: number) => Promise<string | null>;
      }[];
    };
    mocks.rotate = 90;
    try {
      expect(
        await book.sections[0]!.renderReflowRegion({ x0: 0, y0: 0, x1: 10, y1: 10 }),
      ).toBeNull();
      expect(
        await book.sections[0]!.renderReflowRegion({ x0: 5, y0: 5, x1: 5, y1: 20 }),
      ).toBeNull();
    } finally {
      mocks.rotate = 0;
    }
  });
});
