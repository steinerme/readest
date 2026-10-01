import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePdfReflowTTS } from '@/app/reader/hooks/usePdfReflowTTS';
import { reflowPdfText } from '@/utils/pdfReflow';
import { eventDispatcher } from '@/utils/event';

const unsubscribers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  unsubscribers.splice(0).forEach((off) => off());
});
function listen(name: string, callback = vi.fn()) {
  eventDispatcher.on(name, callback);
  unsubscribers.push(() => eventDispatcher.off(name, callback));
  return callback;
}
function harness() {
  const setPage = vi.fn();
  const scrollIntoView = vi.fn();
  const scrollRef = {
    current: { querySelector: vi.fn(() => ({ scrollIntoView })) } as unknown as HTMLElement,
  };
  const page = reflowPdfText(
    [{ str: 'Real sentence.', transform: [14, 0, 0, 14, 50, 700], width: 160, height: 14 }],
    612,
    792,
    true,
  );
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = '<div class="textLayer"><span>Real sentence.</span></div>';
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('span')!);
  const props = { bookKey: 'pdf-1', page: 0, count: 3, result: page, setPage, scrollRef };
  const hook = renderHook((p) => usePdfReflowTTS(p), { initialProps: props });
  return { ...hook, props, range, setPage, scrollIntoView };
}
async function position(sectionIndex: number, sequence: number, range?: Range, bookKey = 'pdf-1') {
  await act(async () => {
    await eventDispatcher.dispatch('tts-position', {
      bookKey,
      sectionIndex,
      sequence,
      range,
      kind: 'sentence',
    });
  });
}
async function state(state: string, bookKey = 'pdf-1') {
  await act(async () => {
    await eventDispatcher.dispatch('tts-playback-state', { bookKey, state });
  });
}

describe('PDF reflow TTS follower', () => {
  it('requests immediate replay on entry and follows real ranges even when page zero', async () => {
    const sync = listen('tts-sync-request');
    const h = harness();
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ detail: { bookKey: 'pdf-1' } }));
    await position(0, 1, h.range);
    expect(h.result.current.highlights).toEqual([{ block: 0, start: 0, end: 14 }]);
    expect(h.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
  });
  it('starts at the current physical page and serializes rapid transport taps', async () => {
    let release!: () => void;
    const speak = listen(
      'tts-speak',
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const h = harness();
    let first!: Promise<void>;
    act(() => {
      first = h.result.current.toggle();
      void h.result.current.toggle();
    });
    expect(h.result.current.pending).toBe(true);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { bookKey: 'pdf-1', index: 0 } }),
    );
    await act(async () => {
      release();
      await first;
    });
    expect(h.result.current.pending).toBe(false);
  });
  it('pauses/resumes through the existing transport and stops via the existing manager path', async () => {
    const toggle = listen('tts-toggle-play');
    const stop = listen('tts-stop');
    const speak = listen('tts-speak');
    const h = harness();
    await state('playing');
    await act(async () => {
      await h.result.current.toggle();
    });
    await state('paused');
    expect(h.result.current.state).toBe('paused');
    await act(async () => {
      await h.result.current.toggle();
    });
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(speak).not.toHaveBeenCalled();
    act(() => h.result.current.stop());
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ detail: { bookKey: 'pdf-1' } }));
    expect(h.result.current.state).toBe('stopped');
    expect(h.result.current.highlights).toEqual([]);
  });
  it('follows physical sections, ignores stale/out-of-order events and other book keys', async () => {
    const h = harness();
    await position(1, 10, h.range);
    expect(h.setPage).toHaveBeenLastCalledWith(1);
    await position(2, 9, h.range);
    await position(2, 11, h.range, 'pdf-other');
    await position(-1, 12, h.range);
    await position(3, 13, h.range);
    expect(h.setPage).toHaveBeenCalledTimes(1);
    await position(2, 14, h.range);
    expect(h.setPage).toHaveBeenLastCalledWith(2);
  });
  it('manual navigation/scrolling suspends following without pausing audio, return resumes latest location', async () => {
    const toggle = listen('tts-toggle-play');
    const h = harness();
    await state('playing');
    await position(0, 1, h.range);
    h.scrollIntoView.mockClear();
    act(() => h.result.current.suspendFollowing());
    await position(1, 2, h.range);
    expect(h.result.current.following).toBe(false);
    expect(h.setPage).not.toHaveBeenCalled();
    expect(h.scrollIntoView).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    act(() => h.result.current.returnToSpeech());
    expect(h.setPage).toHaveBeenLastCalledWith(1);
    h.rerender({ ...h.props, page: 1 });
    expect(h.result.current.following).toBe(true);
    expect(h.scrollIntoView).toHaveBeenCalled();
  });
  it('does not invent highlight for missing Range/mismatched document or wrong displayed page', async () => {
    const h = harness();
    await position(0, 1);
    expect(h.result.current.highlights).toEqual([]);
    await position(1, 2, h.range);
    expect(h.result.current.highlights).toEqual([]);
    h.rerender({ ...h.props, page: 1, result: { ...h.props.result, sourceText: 'different' } });
    expect(h.result.current.highlights).toEqual([]);
  });
  it('ignores unrelated playback states and clears markers on actual terminal stop', async () => {
    const h = harness();
    await state('playing');
    await state('paused', 'other-book');
    expect(h.result.current.state).toBe('playing');
    await position(0, 1, h.range);
    await state('stopped');
    expect(h.result.current.highlights).toEqual([]);
    expect(h.result.current.state).toBe('stopped');
  });
  it('removes listeners on switch to PDF/unmount without stopping audio or late updates', async () => {
    const stop = listen('tts-stop');
    const h = harness();
    h.unmount();
    await position(1, 1, h.range);
    await state('playing');
    expect(h.setPage).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  it('cleans old-book listeners and resets pending requests on bookKey change', async () => {
    const h = harness();
    await state('playing');
    h.rerender({ ...h.props, bookKey: 'pdf-2' });
    await position(1, 1, h.range);
    await state('playing');
    expect(h.setPage).not.toHaveBeenCalled();
    expect(h.result.current.state).toBe('stopped');
    await position(2, 2, h.range, 'pdf-2');
    expect(h.setPage).toHaveBeenCalledWith(2);
  });
});
