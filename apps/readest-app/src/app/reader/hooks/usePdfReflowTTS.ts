import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { eventDispatcher } from '@/utils/event';
import { mapPdfSpeechRange, type ReflowHighlight } from '@/utils/pdfReflowTTS';
import type { ReflowPage } from '@/utils/pdfReflow';

interface Position {
  bookKey: string;
  sectionIndex: number;
  sequence: number;
  kind: 'sentence' | 'word';
  range?: Range;
}
interface Props {
  bookKey: string;
  page: number;
  count: number;
  result: ReflowPage | null;
  setPage: (page: number) => void;
  scrollRef: RefObject<HTMLElement | null>;
}

/** A follower/transport surface only. useTTSControl in the reader remains the
 * sole owner of the TTSController and TTSSessionManager. Closing this overlay
 * removes listeners, never stops/detaches audio or creates a second engine. */
export function usePdfReflowTTS({ bookKey, page, count, result, setPage, scrollRef }: Props) {
  const [state, setState] = useState<'playing' | 'paused' | 'stopped'>('stopped');
  const [pending, setPending] = useState(false);
  const [following, setFollowing] = useState(true);
  const [position, setPosition] = useState<Position | null>(null);
  const [highlights, setHighlights] = useState<ReflowHighlight[]>([]);
  const followingRef = useRef(true);
  const pendingRef = useRef(false);
  const sequenceRef = useRef(-1);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const currentRef = useRef({ page, count, setPage, position, state });
  currentRef.current = { page, count, setPage, position, state };

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    followingRef.current = true;
    pendingRef.current = false;
    setFollowing(true);
    setPending(false);
    sequenceRef.current = -1;
    setPosition(null);
    setHighlights([]);
    setState('stopped');
    const onPosition = (event: CustomEvent<Position>) => {
      const p = event.detail;
      if (
        !active ||
        p?.bookKey !== bookKey ||
        !Number.isInteger(p.sectionIndex) ||
        p.sectionIndex < 0 ||
        p.sectionIndex >= currentRef.current.count ||
        !Number.isFinite(p.sequence) ||
        p.sequence <= sequenceRef.current
      )
        return;
      sequenceRef.current = p.sequence;
      setPosition(p);
      // Physical PDF section boundaries, not reflow paragraph counts.
      if (followingRef.current && p.sectionIndex !== currentRef.current.page)
        currentRef.current.setPage(p.sectionIndex);
    };
    const onState = (event: CustomEvent) => {
      if (!active || event.detail?.bookKey !== bookKey) return;
      const next = event.detail.state;
      if (next !== 'playing' && next !== 'paused' && next !== 'stopped') return;
      setState(next);
      if (next === 'stopped') {
        setPosition(null);
        setHighlights([]);
      }
    };
    eventDispatcher.on('tts-position', onPosition);
    eventDispatcher.on('tts-playback-state', onState);
    void eventDispatcher.dispatch('tts-sync-request', { bookKey });
    return () => {
      active = false;
      mountedRef.current = false;
      requestRef.current++;
      eventDispatcher.off('tts-position', onPosition);
      eventDispatcher.off('tts-playback-state', onState);
    };
  }, [bookKey]);

  useEffect(() => {
    setHighlights(
      position?.sectionIndex === page && position.range && result
        ? mapPdfSpeechRange(result, position.range)
        : [],
    );
  }, [page, result, position]);

  useEffect(() => {
    if (!following || !highlights.length) return;
    // Use the actual marked span, not synthetic timed words. 'nearest' avoids
    // repeatedly moving a sentence already on screen; no smooth-scroll races.
    scrollRef.current?.querySelector('mark[data-reflow-tts]')?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'instant',
    });
  }, [following, highlights, scrollRef]);

  const suspendFollowing = useCallback(() => {
    if (
      !currentRef.current.position &&
      currentRef.current.state === 'stopped' &&
      !pendingRef.current
    )
      return;
    followingRef.current = false;
    setFollowing(false);
  }, []);
  const returnToSpeech = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    const p = currentRef.current.position;
    if (p) currentRef.current.setPage(p.sectionIndex);
    void eventDispatcher.dispatch('tts-sync-request', { bookKey });
  }, [bookKey]);

  const toggle = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const request = ++requestRef.current;
    try {
      if (currentRef.current.state === 'stopped') {
        followingRef.current = true;
        setFollowing(true);
        // Explicit index: starts at this physical page, not the saved PDF CFI.
        await eventDispatcher.dispatch('tts-speak', { bookKey, index: currentRef.current.page });
      } else {
        await eventDispatcher.dispatch('tts-toggle-play', { bookKey });
      }
      if (mountedRef.current && request === requestRef.current)
        await eventDispatcher.dispatch('tts-sync-request', { bookKey });
    } finally {
      if (mountedRef.current && request === requestRef.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, [bookKey]);
  const stop = useCallback(() => {
    requestRef.current++;
    pendingRef.current = false;
    setPending(false);
    setState('stopped');
    setPosition(null);
    setHighlights([]);
    void eventDispatcher.dispatch('tts-stop', { bookKey });
  }, [bookKey]);
  return { state, pending, following, highlights, toggle, stop, suspendFollowing, returnToSpeech };
}
