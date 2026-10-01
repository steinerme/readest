const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const MIN_SWIPE_CLOSE_MS = 140;
const MAX_SWIPE_CLOSE_MS = 260;

/** Whether CSS and programmatic dialog transitions should be skipped. */
export const isDialogMotionReduced = (): boolean => {
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches;
  const isEink =
    typeof document !== 'undefined' && document.documentElement.dataset['eink'] === 'true';

  return prefersReducedMotion || isEink;
};

/** Keep swipe-dismiss feedback deliberate even for noisy/near-zero velocities. */
export const getDialogSwipeCloseDurationMs = (velocity: number): number => {
  const safeVelocity = Number.isFinite(velocity) ? Math.max(velocity, 0.5) : 0.5;
  return Math.round(Math.min(MAX_SWIPE_CLOSE_MS, Math.max(MIN_SWIPE_CLOSE_MS, 150 / safeVelocity)));
};
