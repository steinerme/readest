import { cleanup, render, screen, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  controller: null as unknown as {
    terminated: boolean;
    getSpokenSentence: () => { cfi: string; text: string };
  },
  sessionEvents: new EventTarget(),
}));
vi.mock('@/services/ai/readingSpeech', () => ({
  readingController: (key: string) => (key === 'hash-view' ? m.controller : null),
}));
vi.mock('@/services/tts/TTSSessionManager', () => ({ ttsSessionManager: m.sessionEvents }));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: { getState: () => ({ getView: () => ({ resolveCFI: () => ({ index: 2 }) }) }) },
}));
vi.mock('@/app/reader/components/ai/ReadingAssistantPanel', () => ({
  default: ({ request }: { request: unknown }) => (
    <div data-testid='request'>{JSON.stringify(request)}</div>
  ),
}));
import ReadingAssistantHost from '@/app/reader/components/ai/ReadingAssistantHost';
import { eventDispatcher } from '@/utils/event';
function request() {
  return JSON.parse(screen.getByTestId('request').textContent!);
}
async function position(index: number) {
  await act(() =>
    eventDispatcher.dispatch('tts-position', { bookKey: 'hash-view', sectionIndex: index }),
  );
}
async function open(bookKey = 'hash-view') {
  await act(() => eventDispatcher.dispatch('reading-ai-open', { bookKey, mode: 'listening' }));
}
beforeEach(() => {
  let count = 0;
  m.controller = {
    terminated: false,
    getSpokenSentence: () => ({ cfi: `c${++count}`, text: `sentence${count}` }),
  };
});
afterEach(cleanup);
describe('reading assistant host listening scope', () => {
  it('keeps last eight original sentences from this reading session', async () => {
    render(<ReadingAssistantHost bookKeys={['hash-view']} />);
    for (let i = 0; i < 12; i++) await position(i);
    await open();
    expect(request().seeds).toHaveLength(8);
    expect(request().seeds[0].sectionIndex).toBe(4);
    expect(request().seeds[7].sectionIndex).toBe(11);
  });
  it('does not carry old sentences into a replaced controller', async () => {
    render(<ReadingAssistantHost bookKeys={['hash-view']} />);
    await position(0);
    m.controller = { terminated: false, getSpokenSentence: () => ({ cfi: 'new', text: 'new' }) };
    await act(async () => {
      m.sessionEvents.dispatchEvent(new Event('session-changed'));
    });
    await open();
    expect(request().seeds).toEqual([{ cfi: 'new', text: 'new', sectionIndex: 2 }]);
  });
  it('ignores an unopened book and removes panel when book closes', async () => {
    const view = render(<ReadingAssistantHost bookKeys={['hash-view']} />);
    await open('other-view');
    expect(screen.queryByTestId('request')).toBeNull();
    await open();
    expect(screen.queryByTestId('request')).toBeTruthy();
    view.rerender(<ReadingAssistantHost bookKeys={['other-view']} />);
    expect(screen.queryByTestId('request')).toBeNull();
  });
  it('deduplicates repeated word-boundary events from the same sentence', async () => {
    m.controller.getSpokenSentence = () => ({ cfi: 'same', text: 'same' });
    render(<ReadingAssistantHost bookKeys={['hash-view']} />);
    await position(0);
    await position(0);
    await open();
    expect(request().seeds).toHaveLength(1);
  });
});
