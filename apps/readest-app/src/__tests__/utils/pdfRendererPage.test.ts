import { describe, expect, it } from 'vitest';
import { getPdfRendererPage, isPdfPageVisible } from '@/utils/pdfRendererPage';
describe('PDF physical section index', () => {
  it('uses fixed-layout index including zero without primaryIndex', () => {
    expect(getPdfRendererPage({ index: 0 })).toBe(0);
    expect(isPdfPageVisible({ index: 0 }, 0)).toBe(true);
    expect(getPdfRendererPage({ index: 42 })).toBe(42);
    expect(isPdfPageVisible({ index: 42 }, 42)).toBe(true);
  });
  it('does not accept a prefetched page when the active index says otherwise', () => {
    expect(isPdfPageVisible({ index: 1, getContents: () => [{ index: 0 }, { index: 1 }] }, 0)).toBe(
      false,
    );
  });
  it('supports legacy primaryIndex and fallback visible contents', () => {
    expect(getPdfRendererPage({ primaryIndex: 3 })).toBe(3);
    expect(isPdfPageVisible({ primaryIndex: 3 }, 3)).toBe(true);
    expect(getPdfRendererPage({ getContents: () => [{}, { index: 0 }] })).toBe(0);
    expect(isPdfPageVisible({ getContents: () => [{ index: 0 }, { index: 1 }] }, 1)).toBe(true);
  });
  it('rejects missing, non-finite and negative indices', () => {
    expect(getPdfRendererPage(undefined)).toBeUndefined();
    expect(getPdfRendererPage({ index: -1, primaryIndex: NaN })).toBeUndefined();
    expect(isPdfPageVisible({}, 0)).toBe(false);
  });
});
