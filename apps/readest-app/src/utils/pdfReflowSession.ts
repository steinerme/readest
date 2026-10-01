export interface ReflowSession {
  page: number;
  fontSize: number;
  lineHeight: number;
}
// Match bookDataStore's stable book id, excluding per-view suffixes.
const key = (bookKey: string) => `readest:pdf-reflow:${bookKey.split('-')[0]}`;
export function readReflowSession(bookKey: string, count: number): ReflowSession | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key(bookKey)) ?? 'null',
    ) as ReflowSession | null;
    if (!value || !Number.isInteger(value.page) || value.page < 0 || value.page >= count)
      return null;
    return {
      page: value.page,
      fontSize: Number.isFinite(value.fontSize) ? Math.max(16, Math.min(36, value.fontSize)) : 22,
      lineHeight: [1.5, 1.85, 2.2].includes(value.lineHeight) ? value.lineHeight : 1.85,
    };
  } catch {
    return null;
  }
}
export function writeReflowSession(bookKey: string, state: ReflowSession): void {
  try {
    sessionStorage.setItem(key(bookKey), JSON.stringify(state));
  } catch {
    /* Reading still works if storage is unavailable. */
  }
}
