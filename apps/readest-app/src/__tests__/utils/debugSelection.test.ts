import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDebugSelection,
  blockRange,
  debugLinksEnabled,
  findTextRange,
  parseDebugSelectUrl,
} from '@/utils/debugSelection';

afterEach(() => {
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

describe('debug selection links (preview test hook)', () => {
  it('parses text and block requests strictly', () => {
    expect(
      parseDebugSelectUrl('readest-preview-debug://select?text=%E5%86%B0%E5%9D%97&occurrence=2'),
    ).toEqual({ kind: 'text', text: '冰块', occurrence: 2 });
    expect(parseDebugSelectUrl('readest-preview-debug://select?block=3&start=0&end=12')).toEqual({
      kind: 'block',
      block: 3,
      start: 0,
      end: 12,
    });
    for (const bad of [
      'readest://select?text=x',
      'https://example.com/select?text=x',
      'readest-preview-debug://open?text=x',
      'readest-preview-debug://select?text=',
      'readest-preview-debug://select?text=x&occurrence=0',
      'readest-preview-debug://select?text=x&block=1&start=0&end=2',
      'readest-preview-debug://select?block=1&start=5&end=5',
      'readest-preview-debug://select?block=-1&start=0&end=2',
      'readest-preview-debug://select?block=1&start=0&end=9999',
      `readest-preview-debug://select?text=${'a'.repeat(501)}`,
      'not a url',
    ])
      expect(parseDebugSelectUrl(bad)).toBeNull();
  });
  it('is off unless the preview build flag is set', () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_DEBUG_LINKS', '');
    expect(debugLinksEnabled()).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_DEBUG_LINKS', '1');
    expect(debugLinksEnabled()).toBe(true);
  });
  it('finds the N-th match, also across text nodes', () => {
    document.body.innerHTML = '<p>冰块融化。<b>冰</b>块越小，融化越快。</p>';
    expect(findTextRange(document.body, '冰块', 1)!.toString()).toBe('冰块');
    const second = findTextRange(document.body, '冰块越小', 1)!;
    expect(second.toString()).toBe('冰块越小');
    expect(second.startContainer.parentElement!.tagName).toBe('B');
    expect(findTextRange(document.body, '冰块', 2)!.toString()).toBe('冰块');
    expect(findTextRange(document.body, '冰块', 3)).toBeNull();
  });
  it('selects a character range inside one reflow block', () => {
    document.body.innerHTML =
      '<article><p data-reflow-block="0">第一段</p><p data-reflow-block="1">表面积按<mark>长度</mark>的平方增大</p></article>';
    expect(blockRange(document.body, 1, 2, 6)!.toString()).toBe('积按长度');
    expect(blockRange(document.body, 1, 0, 99)).toBeNull();
    expect(blockRange(document.body, 7, 0, 1)).toBeNull();
  });
  it('places a real DOM selection and fires selectionchange in the reflow article', () => {
    document.body.innerHTML =
      '<article class="r"><p data-reflow-block="0">尺寸的变化将会影响形状。</p></article>';
    const fired = vi.fn();
    document.addEventListener('selectionchange', fired);
    const reflow = document.querySelector<HTMLElement>('article')!;
    const result = applyDebugSelection(
      { kind: 'text', text: '影响形状', occurrence: 1 },
      { reflow, sections: [] },
    );
    expect(result).toEqual({ ok: true, text: '影响形状', where: 'reflow' });
    expect(document.getSelection()!.toString()).toBe('影响形状');
    expect(fired).toHaveBeenCalled();
    document.removeEventListener('selectionchange', fired);
  });
  it('falls back to the original view documents and counts across sections', () => {
    // Section documents live in iframes (they need a window for getSelection).
    const frame = (html: string) => {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument!;
      doc.body.innerHTML = html;
      return doc;
    };
    const a = frame('<p>第一节提到恐龙。</p>');
    const b = frame('<p>第二节再次提到恐龙。</p>');
    const result = applyDebugSelection(
      { kind: 'text', text: '恐龙', occurrence: 2 },
      { reflow: null, sections: [a, b] },
    );
    expect(result).toMatchObject({ ok: true, where: 'original' });
    expect(b.getSelection()!.toString()).toBe('恐龙');
  });
  it('reports clear failures instead of selecting something else', () => {
    expect(
      applyDebugSelection(
        { kind: 'text', text: 'x', occurrence: 1 },
        { reflow: null, sections: [] },
      ),
    ).toEqual({ ok: false, reason: 'not-reading' });
    expect(
      applyDebugSelection(
        { kind: 'block', block: 0, start: 0, end: 1 },
        { reflow: null, sections: [document] },
      ),
    ).toEqual({ ok: false, reason: 'block-needs-reflow' });
    document.body.innerHTML = '<article><p>正文</p></article>';
    expect(
      applyDebugSelection(
        { kind: 'text', text: '不存在', occurrence: 1 },
        { reflow: document.querySelector('article'), sections: [] },
      ),
    ).toEqual({ ok: false, reason: 'not-found' });
  });
});
