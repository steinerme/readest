import { useEffect, useRef, useState } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { eventDispatcher } from '@/utils/event';
import { useReadingChromeHidden } from '@/app/reader/hooks/useReadingChromeHidden';
import {
  RESUME_WRITE_INTERVAL_MS,
  bookHashOf,
  captureOpenedResume,
  describeResume,
  releaseOpenedResume,
  shouldWelcomeBack,
  writeResume,
  type ResumePoint,
} from '@/services/ai/readingResume';

const AUTO_DISMISS_MS = 20_000;

/**
 * Records where you are while reading (device-local, never synced or sent) and,
 * after a real break, shows a one-line "last time you were here" card with a
 * recap shortcut. Nothing is requested from AI until you tap recap and confirm
 * the usual send preview.
 */
export default function ReadingResumeCard({
  bookKey,
  topInset = 0,
}: {
  bookKey: string;
  topInset?: number;
}) {
  const hash = bookHashOf(bookKey);
  // Captured once per open, before this component ever writes a new position.
  const [point] = useState<ResumePoint | null>(() => captureOpenedResume(bookKey));
  const [welcome, setWelcome] = useState(() => shouldWelcomeBack(point));
  const inited = useReaderStore((s) => !!s.viewStates[bookKey]?.inited);
  const preview = useReaderStore((s) => !!s.viewStates[bookKey]?.previewMode);
  const progress = useBookProgress(bookKey);
  const reflow = usePdfReflowStore((s) => s.sessions[bookKey]);
  const hidden = useReadingChromeHidden(bookKey);
  const latest = useRef<ResumePoint | null>(null);
  const dirty = useRef(false);

  // --- recording --------------------------------------------------------
  useEffect(() => {
    if (!inited || preview || !progress?.location) return;
    latest.current = {
      at: Date.now(),
      cfi: progress.location,
      label: progress.sectionLabel ?? '',
      ...(progress.page ? { page: reflow?.page != null ? reflow.page + 1 : progress.page } : {}),
      ...(Number.isFinite(progress.fraction) ? { fraction: progress.fraction } : {}),
    };
    dirty.current = true;
  }, [inited, preview, progress, reflow?.page]);
  useEffect(() => {
    const flush = () => {
      if (dirty.current && latest.current) {
        latest.current.at = Date.now();
        writeResume(hash, latest.current);
        dirty.current = false;
      }
    };
    const timer = setInterval(flush, RESUME_WRITE_INTERVAL_MS);
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
      releaseOpenedResume(bookKey);
    };
  }, [hash, bookKey]);

  // --- welcome-back card --------------------------------------------------
  useEffect(() => {
    if (!welcome) return;
    const timer = setTimeout(() => setWelcome(false), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [welcome]);
  // Once the reader moves on from where they were, the reminder has done its job.
  const startLocation = useRef<string | null>(null);
  useEffect(() => {
    if (!welcome || !progress?.location) return;
    if (startLocation.current === null) startLocation.current = progress.location;
    else if (startLocation.current !== progress.location) setWelcome(false);
  }, [welcome, progress?.location]);

  if (!welcome || !point || !inited || hidden) return null;
  const away = describeResume(point);
  return (
    <div
      role='status'
      data-reading-resume='visible'
      className='absolute inset-x-3 z-30 mx-auto flex max-w-md flex-col gap-2 rounded-2xl bg-base-300/95 p-3 text-sm shadow-lg backdrop-blur-sm'
      style={{ top: topInset + 12 }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <p className='font-semibold'>欢迎回来 · 上次读到</p>
      <p className='break-words text-base-content/80'>{away}</p>
      <div className='flex flex-wrap justify-end gap-2'>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => setWelcome(false)}>
          知道了
        </button>
        <button
          type='button'
          className='btn btn-primary btn-sm'
          onClick={() => {
            setWelcome(false);
            void eventDispatcher.dispatch('reading-ai-open', { bookKey, mode: 'recap' });
          }}
        >
          前情提要
        </button>
      </div>
    </div>
  );
}
