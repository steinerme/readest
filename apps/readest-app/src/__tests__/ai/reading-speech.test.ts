import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  session: null as unknown as { controller: { state: string; terminated: boolean } },
  dispatch: vi.fn(),
  create: vi.fn(),
  decode: vi.fn(async () => ({ duration: 1 })),
  start: vi.fn(),
  schedule: vi.fn(),
  end: vi.fn(),
  abort: vi.fn(),
  warm: vi.fn(async () => {}),
  callback: null as null | ((event: { type: string }) => void),
}));
vi.mock('@/libs/edgeTTS', () => ({
  EdgeSpeechTTS: class {
    createAudioData = m.create;
  },
}));
vi.mock('@/services/tts/WebAudioPlayer', () => ({
  WebAudioPlayer: class {
    ensureContext = m.warm;
    decode = m.decode;
    abortSession = m.abort;
    startSession(cb: (event: { type: string }) => void) {
      m.callback = cb;
      m.start(cb);
      return 1;
    }
    scheduleChunk = m.schedule;
    endSession() {
      m.end();
      queueMicrotask(() => m.callback?.({ type: 'session-end' }));
    }
  },
}));
vi.mock('@/services/tts/TTSSessionManager', () => ({
  ttsSessionManager: { getSessionByHash: () => m.session },
  asTTSController: (s: unknown) => s,
}));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: m.dispatch } }));
import {
  pauseReading,
  resumeReading,
  speakReadingAnswer,
  warmReadingSpeech,
} from '@/services/ai/readingSpeech';
beforeEach(() => {
  vi.clearAllMocks();
  m.session = { controller: { state: 'playing', terminated: false } };
  m.dispatch.mockImplementation(async () => {
    m.session.controller.state = m.session.controller.state === 'playing' ? 'paused' : 'playing';
  });
  m.create.mockResolvedValue({ data: new ArrayBuffer(4) });
});
describe('reading speech isolation and resume gates', () => {
  it('pauses via existing transport and resumes only the same session', async () => {
    const controller = m.session.controller;
    expect(await pauseReading('hash-view')).toBe(true);
    expect(m.dispatch).toHaveBeenCalledWith('tts-toggle-play', { bookKey: 'hash-view' });
    expect(await resumeReading('hash-view', controller)).toBe(true);
  });
  it('never starts a replaced or terminated session', async () => {
    const original = m.session.controller;
    m.session = { controller: { state: 'paused', terminated: false } };
    expect(await resumeReading('hash-view', original)).toBe(false);
    m.session.controller.terminated = true;
    expect(await resumeReading('hash-view')).toBe(false);
    expect(m.dispatch).not.toHaveBeenCalled();
  });
  it('does not toggle a playing session on resume or paused session on pause', async () => {
    expect(await resumeReading('hash-view')).toBe(false);
    m.session.controller.state = 'paused';
    expect(await pauseReading('hash-view')).toBe(false);
    expect(m.dispatch).not.toHaveBeenCalled();
  });
  it('uses isolated chunks and removes source markup from speech', async () => {
    warmReadingSpeech();
    await speakReadingAnswer({ text: '**解释** [s0p0]', signal: new AbortController().signal });
    expect(m.create.mock.calls[0]![0]).toMatchObject({
      text: '解释 ',
      lang: 'zh-CN',
      voice: 'zh-CN-XiaoxiaoNeural',
    });
    expect(m.schedule).toHaveBeenCalledOnce();
    expect(m.dispatch).not.toHaveBeenCalled();
  });
  it('splits long answers into bounded synthesis requests', async () => {
    await speakReadingAnswer({ text: '字'.repeat(1100), signal: new AbortController().signal });
    expect(m.create).toHaveBeenCalledTimes(3);
    expect(m.create.mock.calls.map((c) => c[0].text.length)).toEqual([500, 500, 100]);
  });
  it('never synthesizes after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      speakReadingAnswer({ text: '字', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(m.create).not.toHaveBeenCalled();
  });
  it('drops late synthesis results after cancel without starting audio', async () => {
    const controller = new AbortController();
    m.create.mockImplementation(async () => {
      controller.abort();
      return { data: new ArrayBuffer(4) };
    });
    await expect(
      speakReadingAnswer({ text: '字', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(m.start).not.toHaveBeenCalled();
  });
  it('propagates voice failure instead of auto-resuming original speech', async () => {
    m.create.mockRejectedValue(new Error('network'));
    await expect(
      speakReadingAnswer({ text: '字', signal: new AbortController().signal }),
    ).rejects.toThrow('network');
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
  });
});

it('escapes XML characters before sending explanation text to speech', async () => {
  await speakReadingAnswer({ text: 'A < B & C > D', signal: new AbortController().signal });
  expect(m.create.mock.calls[0]![0].text).toBe('A &lt; B &amp; C &gt; D');
});
it('cancels immediately while synthesis remains unresolved', async () => {
  const controller = new AbortController();
  m.create.mockImplementation(() => new Promise(() => {}));
  const pending = speakReadingAnswer({ text: '字', signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(m.start).not.toHaveBeenCalled();
});
