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
}));
vi.mock('@pdfjs/pdf.min.mjs', () => {
  class PDFDataRangeTransport {
    onDataRange = vi.fn();
  }
  (globalThis as unknown as { pdfjsLib: unknown }).pdfjsLib = {
    GlobalWorkerOptions: {},
    PDFDataRangeTransport,
    getDocument: () => ({
      destroy: mocks.destroy,
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          view: [20, 30, 620, 830],
          rotate: 0,
          getViewport: () => ({ width: 600, height: 800 }),
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
});
