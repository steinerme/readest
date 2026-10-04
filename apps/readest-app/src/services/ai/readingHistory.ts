/**
 * Reading-assistant history: question / answer pairs kept on this device so a
 * closed panel does not lose them. Stored per book in localStorage, never
 * synced, never sent anywhere by this module. Only plain text the user already
 * saw is kept — no cfi, no passages' source text beyond short citation labels.
 */
export interface HistoryCitation {
  id: string;
  label: string;
  cfi: string;
  sectionIndex: number;
}
export interface HistoryEntry {
  id: string;
  at: number;
  question: string;
  answer: string;
  /** scope the answer was grounded in (selection / current / read / all / listening) */
  scope: string;
  /** only citations that were actually sent and cited, so they can be jumped to again */
  citations: HistoryCitation[];
}

const KEY_PREFIX = 'readest.readingHistory.v1.';
export const HISTORY_MAX_ENTRIES = 50;
export const HISTORY_MAX_CHARS = 400_000;
const ANSWER_MAX = 8000;
const QUESTION_MAX = 2000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const clean = (value: unknown): HistoryEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<HistoryEntry>;
  if (
    typeof v.id !== 'string' ||
    typeof v.at !== 'number' ||
    typeof v.question !== 'string' ||
    typeof v.answer !== 'string'
  )
    return null;
  const citations = Array.isArray(v.citations)
    ? v.citations
        .filter(
          (c): c is HistoryCitation =>
            !!c &&
            typeof c.id === 'string' &&
            typeof c.label === 'string' &&
            typeof c.cfi === 'string' &&
            !!c.cfi &&
            typeof c.sectionIndex === 'number',
        )
        .slice(0, 14)
    : [];
  return {
    id: v.id,
    at: v.at,
    question: v.question.slice(0, QUESTION_MAX),
    answer: v.answer.slice(0, ANSWER_MAX),
    scope: typeof v.scope === 'string' ? v.scope : 'current',
    citations,
  };
};

export function loadHistory(hash: string, store: Store | null = defaultStore()): HistoryEntry[] {
  if (!store || !hash) return [];
  try {
    const raw = store.getItem(KEY_PREFIX + hash);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(clean).filter((e): e is HistoryEntry => !!e);
  } catch {
    return [];
  }
}

function persist(hash: string, entries: HistoryEntry[], store: Store): boolean {
  let kept = entries.slice(-HISTORY_MAX_ENTRIES);
  let json = JSON.stringify(kept);
  while (json.length > HISTORY_MAX_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    json = JSON.stringify(kept);
  }
  try {
    store.setItem(KEY_PREFIX + hash, json);
    return true;
  } catch {
    return false;
  }
}

export function appendHistory(
  hash: string,
  entry: Omit<HistoryEntry, 'question' | 'answer'> & { question: string; answer: string },
  store: Store | null = defaultStore(),
): HistoryEntry[] {
  if (!store || !hash) return [];
  const next = clean(entry);
  if (!next) return loadHistory(hash, store);
  const all = [...loadHistory(hash, store).filter((e) => e.id !== next.id), next];
  persist(hash, all, store);
  return loadHistory(hash, store);
}

export function deleteHistoryEntry(
  hash: string,
  id: string,
  store: Store | null = defaultStore(),
): HistoryEntry[] {
  if (!store || !hash) return [];
  const rest = loadHistory(hash, store).filter((e) => e.id !== id);
  if (rest.length) persist(hash, rest, store);
  else {
    try {
      store.removeItem(KEY_PREFIX + hash);
    } catch {
      /* nothing to clean */
    }
  }
  return rest;
}

export function clearHistory(hash: string, store: Store | null = defaultStore()) {
  if (!store || !hash) return;
  try {
    store.removeItem(KEY_PREFIX + hash);
  } catch {
    /* nothing to clean */
  }
}
