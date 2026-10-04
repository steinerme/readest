/**
 * "Where did I stop last time" — a device-local record, never synced and never
 * sent anywhere. It is written while reading and read once when a book opens,
 * so the reader can offer a one-line reminder and a recap shortcut.
 */
export interface ResumePoint {
  /** epoch ms of the last time reading progress was recorded */
  at: number;
  /** reading-location CFI at that time; used for "back to where I stopped" */
  cfi: string;
  /** chapter / section label when it was recorded */
  label: string;
  /** 1-based page number if known (PDF physical page or page-list number) */
  page?: number;
  /** 0..1 overall progress */
  fraction?: number;
}

const KEY_PREFIX = 'readest.resume.v1.';
/** Away shorter than this never triggers the welcome-back card. */
export const RESUME_MIN_AWAY_MS = 6 * 60 * 60 * 1000;
/** Progress is persisted at most this often while reading. */
export const RESUME_WRITE_INTERVAL_MS = 20 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const bookHashOf = (bookKey: string) => bookKey.split('-')[0]!;

export function readResume(hash: string, store: Store | null = defaultStore()): ResumePoint | null {
  if (!store || !hash) return null;
  try {
    const raw = store.getItem(KEY_PREFIX + hash);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ResumePoint>;
    if (
      typeof value.at !== 'number' ||
      !Number.isFinite(value.at) ||
      typeof value.cfi !== 'string' ||
      !value.cfi
    )
      return null;
    return {
      at: value.at,
      cfi: value.cfi,
      label: typeof value.label === 'string' ? value.label.slice(0, 200) : '',
      ...(typeof value.page === 'number' && value.page > 0 ? { page: value.page } : {}),
      ...(typeof value.fraction === 'number' && value.fraction >= 0 && value.fraction <= 1
        ? { fraction: value.fraction }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeResume(
  hash: string,
  point: ResumePoint,
  store: Store | null = defaultStore(),
): boolean {
  if (!store || !hash || !point.cfi) return false;
  try {
    store.setItem(KEY_PREFIX + hash, JSON.stringify(point));
    return true;
  } catch {
    return false;
  }
}

/**
 * The position the book was opened at, captured once per open (view session).
 * The live record keeps being overwritten while reading, so this snapshot is
 * what "last time" means for the whole session.
 */
const opened = new Map<string, ResumePoint | null>();
export function captureOpenedResume(
  bookKey: string,
  store: Store | null = defaultStore(),
): ResumePoint | null {
  if (opened.has(bookKey)) return opened.get(bookKey) ?? null;
  const point = readResume(bookHashOf(bookKey), store);
  opened.set(bookKey, point);
  return point;
}
export function getOpenedResume(bookKey: string): ResumePoint | null {
  return opened.get(bookKey) ?? null;
}
export function releaseOpenedResume(bookKey: string) {
  opened.delete(bookKey);
}

export function formatAway(ms: number): string {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ms < hour) return `${Math.max(1, Math.round(ms / minute))} 分钟前`;
  if (ms < day) return `${Math.round(ms / hour)} 小时前`;
  if (ms < 30 * day) return `${Math.round(ms / day)} 天前`;
  if (ms < 365 * day) return `${Math.round(ms / (30 * day))} 个月前`;
  return `${Math.round(ms / (365 * day))} 年前`;
}

export function describeResume(point: ResumePoint, now = Date.now()): string {
  const parts: string[] = [];
  if (point.label) parts.push(point.label);
  if (point.page) parts.push(`第 ${point.page} 页`);
  if (typeof point.fraction === 'number') parts.push(`${Math.round(point.fraction * 100)}%`);
  parts.push(formatAway(Math.max(0, now - point.at)));
  return parts.join(' · ');
}

/** Show the welcome-back card only after a real break and only once per open. */
export function shouldWelcomeBack(point: ResumePoint | null, now = Date.now()): boolean {
  return !!point && now - point.at >= RESUME_MIN_AWAY_MS;
}
