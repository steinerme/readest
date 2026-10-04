import { useEffect, useRef, useState } from 'react';
import { eventDispatcher } from '@/utils/event';
import { readingController } from '@/services/ai/readingSpeech';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import type { ReadingSeed } from '@/services/ai/readingContext';
import ReadingAssistantPanel from './ReadingAssistantPanel';
import { useReaderStore } from '@/store/readerStore';

export interface ReadingAssistantRequest {
  bookKey: string;
  mode?: 'selection' | 'book' | 'listening' | 'recap';
  seed?: ReadingSeed;
}

export default function ReadingAssistantHost({ bookKeys }: { bookKeys: string[] }) {
  const [request, setRequest] = useState<
    | (ReadingAssistantRequest & {
        seeds: ReadingSeed[];
        nonce: number;
      })
    | null
  >(null);
  const recent = useRef(new Map<string, { controller: object; seeds: ReadingSeed[] }>());
  useEffect(() => {
    const onPosition = (event: CustomEvent) => {
      const detail = event.detail as { bookKey?: string; sectionIndex?: number };
      if (!detail.bookKey || !bookKeys.includes(detail.bookKey)) return;
      const controller = readingController(detail.bookKey);
      if (!controller || controller.terminated) return;
      const sentence = controller.getSpokenSentence();
      if (!sentence) return;
      let entry = recent.current.get(detail.bookKey);
      if (!entry || entry.controller !== controller) {
        entry = { controller, seeds: [] };
        recent.current.set(detail.bookKey, entry);
      }
      if (entry.seeds.at(-1)?.cfi === sentence.cfi) return;
      const index = detail.sectionIndex;
      if (typeof index !== 'number') return;
      entry.seeds.push({ ...sentence, text: sentence.text.slice(0, 4000), sectionIndex: index });
      entry.seeds = entry.seeds.slice(-8);
    };
    const onOpen = (event: CustomEvent) => {
      const detail = event.detail as ReadingAssistantRequest;
      if (!detail?.bookKey || !bookKeys.includes(detail.bookKey)) return;
      const controller = readingController(detail.bookKey);
      const entry = recent.current.get(detail.bookKey);
      let seeds =
        controller && !controller.terminated && entry?.controller === controller
          ? [...entry.seeds]
          : [];
      const sentence = controller && !controller.terminated ? controller.getSpokenSentence() : null;
      if (sentence && !seeds.length) {
        try {
          const index = useReaderStore
            .getState()
            .getView(detail.bookKey)
            ?.resolveCFI(sentence.cfi).index;
          if (typeof index === 'number')
            seeds = [{ ...sentence, text: sentence.text.slice(0, 4000), sectionIndex: index }];
        } catch {
          /* Don't guess an anchor if the active source has no text. */
        }
      }
      setRequest({ ...detail, seeds, nonce: Date.now() });
    };
    const onSession = () => {
      for (const [key, entry] of recent.current) {
        if (readingController(key) !== entry.controller) recent.current.delete(key);
      }
    };
    eventDispatcher.on('tts-position', onPosition);
    eventDispatcher.on('reading-ai-open', onOpen);
    ttsSessionManager.addEventListener('session-changed', onSession);
    return () => {
      eventDispatcher.off('tts-position', onPosition);
      eventDispatcher.off('reading-ai-open', onOpen);
      ttsSessionManager.removeEventListener('session-changed', onSession);
    };
  }, [bookKeys]);
  useEffect(() => {
    for (const key of recent.current.keys())
      if (!bookKeys.includes(key)) recent.current.delete(key);
    if (request && !bookKeys.includes(request.bookKey)) setRequest(null);
  }, [bookKeys, request]);
  return request ? (
    <ReadingAssistantPanel key={request.nonce} request={request} onClose={() => setRequest(null)} />
  ) : null;
}
