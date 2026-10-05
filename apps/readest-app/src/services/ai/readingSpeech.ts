import { EdgeSpeechTTS } from '@/libs/edgeTTS';
import { WebAudioPlayer, type TTSAudioContext } from '@/services/tts/WebAudioPlayer';
import { ttsSessionManager, asTTSController } from '@/services/tts/TTSSessionManager';
import { eventDispatcher } from '@/utils/event';

let explanationPlayer: WebAudioPlayer | null = null;
function getExplanationPlayer() {
  if (!explanationPlayer)
    explanationPlayer = new WebAudioPlayer(() => new AudioContext() as unknown as TTSAudioContext);
  return explanationPlayer;
}
export function warmReadingSpeech() {
  if (typeof AudioContext !== 'undefined')
    void getExplanationPlayer()
      .ensureContext()
      .catch(() => {});
}

export async function pauseReading(bookKey: string): Promise<boolean> {
  const session = ttsSessionManager.getSessionByHash(bookKey.split('-')[0]!);
  if (!session || session.controller.state !== 'playing' || session.controller.terminated)
    return false;
  await eventDispatcher.dispatch('tts-toggle-play', { bookKey });
  return session.controller.state !== 'playing';
}
export async function resumeReading(bookKey: string, expected?: object): Promise<boolean> {
  const session = ttsSessionManager.getSessionByHash(bookKey.split('-')[0]!);
  if (!session || session.controller.terminated || (expected && session.controller !== expected))
    return false;
  if (!session.controller.state.includes('paused')) return false;
  await eventDispatcher.dispatch('tts-toggle-play', { bookKey });
  return true;
}
export function readingController(bookKey: string) {
  return asTTSController(ttsSessionManager.getSessionByHash(bookKey.split('-')[0]!)?.controller);
}
export interface ReadingSpeechProgress {
  phase: 'synthesizing' | 'playing';
  /** 1-based index of the current chunk. */
  chunk: number;
  total: number;
}
export async function speakReadingAnswer(options: {
  text: string;
  signal: AbortSignal;
  rate?: number;
  onProgress?: (progress: ReadingSpeechProgress) => void;
}): Promise<void> {
  const player = getExplanationPlayer();
  const text = options.text.replace(/\[s\d+(?:p\d+|seed\d+)\]/g, '').replace(/[*#`]/g, '');
  const chunks = text.match(/[\s\S]{1,500}/g) ?? [];
  const edge = new EdgeSpeechTTS('wss');
  for (const [i, chunk] of chunks.entries()) {
    if (options.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    options.onProgress?.({ phase: 'synthesizing', chunk: i + 1, total: chunks.length });
    // This synthesis uses its own AudioContext, never the book's client or
    // shared context. No engine shutdown / voice reset touches the book.
    const { data } = await abortableSynthesis(
      edge.createAudioData({
        text: chunk.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        lang: 'zh-CN',
        voice: 'zh-CN-XiaoxiaoNeural',
        rate: options.rate ?? 1,
        pitch: 1,
      }),
      options.signal,
    );
    if (options.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const buffer = await player.decode(data);
    if (options.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        player.abortSession();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const generation = player.startSession((event) => {
        if (event.type === 'session-end') {
          options.signal.removeEventListener('abort', stop);
          resolve();
        } else if (event.type === 'context-error') {
          options.signal.removeEventListener('abort', stop);
          player.abortSession();
          reject(new Error('VOICE_FAILED'));
        }
      });
      options.signal.addEventListener('abort', stop, { once: true });
      options.onProgress?.({ phase: 'playing', chunk: i + 1, total: chunks.length });
      player.scheduleChunk(generation, buffer, { trimStartSec: 0, mediaScale: 1, gapSec: 0 });
      player.endSession(generation);
    });
  }
}

function abortableSynthesis<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(value as T);
    };
    const cancel = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('VOICE_TIMEOUT')), 45000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    // EdgeSpeechTTS doesn't expose cancellation of the in-flight websocket;
    // discard its eventual result. Never schedule audio after this gate closes.
    promise.then(
      (value) => finish(null, value),
      (error) => finish(error),
    );
  });
}
