import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  provider: vi.fn(() => ({ getModel: () => 'mock-model' })),
}));
vi.mock('ai', () => ({ streamText: mocks.stream, generateText: vi.fn() }));
vi.mock('@/services/ai/providers', () => ({ getAIProvider: mocks.provider }));
import {
  RECAP_RECENT,
  RECAP_SAMPLED,
  assemblePassages,
  bm25,
  collectReadingContext,
  normalizeExtraTerms,
  pickRecapPassages,
  searchTerms,
  termFrequencies,
  thinRecapPool,
} from '@/services/ai/readingContext';
import { expandQueryTerms } from '@/services/ai/readingAssistant';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import {
  HISTORY_MAX_ENTRIES,
  appendHistory,
  clearHistory,
  deleteHistoryEntry,
  loadHistory,
} from '@/services/ai/readingHistory';
import {
  canSkipConfirmation,
  clearAllConsent,
  consentKey,
  hasConsent,
  setConsent,
} from '@/services/ai/readingConsent';
import {
  RESUME_MIN_AWAY_MS,
  captureOpenedResume,
  describeResume,
  formatAway,
  readResume,
  releaseOpenedResume,
  shouldWelcomeBack,
  writeResume,
} from '@/services/ai/readingResume';
import type { BookDoc, SectionItem } from '@/libs/document';
import type { FoliateView } from '@/types/view';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}
const signal = () => new AbortController().signal;

/** One section per entry; each entry may hold several 1000+ char paragraphs of text. */
function fixture(texts: string[]) {
  const docs = texts.map((text) => {
    const doc = document.implementation.createHTMLDocument('');
    const p = doc.createElement('p');
    p.textContent = text;
    doc.body.appendChild(p);
    return doc;
  });
  const sections = docs.map((doc, index) => ({
    id: `c${index}`,
    href: `c${index}.html`,
    createDocument: vi.fn(async () => doc),
    linear: 'yes',
  })) as unknown as SectionItem[];
  let n = 0;
  const view = {
    getCFI: vi.fn((index: number) => `cfi(${index}:${n++})`),
    resolveCFI: vi.fn(),
  } as unknown as FoliateView;
  const bookDoc = {
    sections,
    toc: [],
    splitTOCHref: (href: string) => [href, null],
  } as unknown as BookDoc;
  return { sections, view, bookDoc };
}

beforeEach(() => vi.clearAllMocks());

describe('BM25 retrieval with neighbouring context', () => {
  it('ranks a rare-term hit above a common-term hit of the same size and ignores empty queries', () => {
    const terms = ['的', '量子'];
    const items = [
      { tf: termFrequencies('的', terms), len: 100 },
      { tf: termFrequencies('量子', terms), len: 100 },
      { tf: termFrequencies('的', terms), len: 100 },
      { tf: termFrequencies('无关内容', terms), len: 100 },
    ];
    const scores = bm25(items, { count: 4, length: 400 });
    expect(scores[1]!).toBeGreaterThan(scores[0]!);
    expect(scores[0]!).toBeCloseTo(scores[2]!);
    expect(scores[3]!).toBe(0);
    expect(bm25([], { count: 0, length: 0 })).toEqual([]);
  });
  it('normalises a long passage so it does not win on length alone', () => {
    const scores = bm25(
      [
        { tf: [2], len: 200 },
        { tf: [2], len: 5000 },
      ],
      { count: 2, length: 5200 },
    );
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });
  it('adds the paragraphs before and after a hit and returns reading order', async () => {
    const f = fixture([
      `${'前文铺垫。'.repeat(150)}${'目标关键词出现。'.repeat(20)}${'后文说明。'.repeat(150)}`,
    ]);
    const result = await collectReadingContext({
      ...f,
      scope: 'all',
      sectionIndex: 0,
      isPdf: false,
      question: '目标关键词',
      spoilerProtection: false,
      signal: signal(),
    });
    const ids = result.passages.map((p) => Number(/p(\d+)$/.exec(p.id)![1]));
    expect(ids.length).toBeGreaterThan(1);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
  it('merges model-suggested words, cleans them and caps the list', () => {
    expect(
      normalizeExtraTerms([
        '  同义词 ',
        'a',
        '',
        '这是一个超过十二个字符的非常长的词语',
        '!!',
        'Quantum',
      ]),
    ).toEqual(['同义词', 'quantum']);
    expect(normalizeExtraTerms(Array.from({ length: 40 }, (_, i) => `词语${i}`))).toHaveLength(16);
    const merged = searchTerms('知识判断', ['认知']);
    expect(merged).toContain('认知');
    expect(merged).toContain('知识');
  });
  it('finds a passage through a suggested synonym the question never used', async () => {
    const f = fixture(['这里只谈论汽车的发展历史。', '这里只谈论大象的生活习性。']);
    const without = await collectReadingContext({
      ...f,
      scope: 'all',
      sectionIndex: 0,
      isPdf: false,
      question: '轿车',
      spoilerProtection: false,
      signal: signal(),
    });
    expect(without.warnings.join('')).toContain('未找到关键词匹配');
    const withTerms = await collectReadingContext({
      ...f,
      scope: 'all',
      sectionIndex: 0,
      isPdf: false,
      question: '轿车',
      extraTerms: ['汽车'],
      spoilerProtection: false,
      signal: signal(),
    });
    expect(withTerms.warnings).toEqual([]);
    expect(withTerms.passages.map((p) => p.text).join('')).toContain('汽车');
  });
  it('never exceeds the passage / character budget when assembling context', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      candidate: {
        passage: {
          id: `s0p${i * 1000}`,
          text: 'x'.repeat(1000),
          cfi: `c${i}`,
          sectionIndex: 0,
          label: 'l',
        },
        pos: i,
        len: 1000,
        tf: [1],
        prev: {
          id: `s0p${i * 1000 - 1}`,
          text: 'y'.repeat(1000),
          cfi: `p${i}`,
          sectionIndex: 0,
          label: 'l',
        },
      },
      score: 30 - i,
    }));
    const picked = assemblePassages(candidates);
    expect(picked.length).toBeLessThanOrEqual(14);
    expect(picked.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(14000);
  });
});

describe('question-only query expansion', () => {
  const settings = { ...DEFAULT_AI_SETTINGS, enabled: true };
  const stream = (parts: string[], reason = 'stop') =>
    mocks.stream.mockReturnValue({
      textStream: (async function* () {
        for (const part of parts) yield part;
      })(),
      finishReason: Promise.resolve(reason),
    });
  it('sends only the question and parses a JSON array, even when streamed in pieces', async () => {
    stream(['好的：["汽', '车","轿车", 3, "x"]']);
    const terms = await expandQueryTerms({ settings, question: '轿车怎么发展', signal: signal() });
    expect(terms).toEqual(['汽车', '轿车']);
    const call = mocks.stream.mock.calls[0]![0];
    expect(call.messages).toEqual([{ role: 'user', content: '轿车怎么发展' }]);
    expect(call.maxRetries).toBe(0);
    expect(JSON.stringify(call)).not.toContain('passage');
  });
  it('returns nothing (so local search continues) on any failure or when disabled', async () => {
    mocks.stream.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await expandQueryTerms({ settings, question: 'q', signal: signal() })).toEqual([]);
    stream(['not json']);
    expect(await expandQueryTerms({ settings, question: 'q', signal: signal() })).toEqual([]);
    stream(['["a词"]'], 'error');
    expect(await expandQueryTerms({ settings, question: 'q', signal: signal() })).toEqual([]);
    mocks.stream.mockClear();
    expect(
      await expandQueryTerms({
        settings: { ...settings, enabled: false },
        question: 'q',
        signal: signal(),
      }),
    ).toEqual([]);
    expect(await expandQueryTerms({ settings, question: '   ', signal: signal() })).toEqual([]);
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('propagates cancellation instead of swallowing it', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      expandQueryTerms({ settings, question: 'q', signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('recap passages', () => {
  it('keeps everything when short, otherwise newest few plus an even sample', () => {
    const short = Array.from({ length: 5 }, (_, i) => i);
    expect(pickRecapPassages(short)).toEqual(short);
    const all = Array.from({ length: 200 }, (_, i) => i);
    const picked = pickRecapPassages(all);
    expect(picked).toHaveLength(RECAP_RECENT + RECAP_SAMPLED);
    expect(picked.slice(-RECAP_RECENT)).toEqual(all.slice(-RECAP_RECENT));
    const earlier = picked.slice(0, RECAP_SAMPLED);
    expect([...earlier].sort((a, b) => a - b)).toEqual(earlier);
    expect(earlier[0]!).toBeLessThan(40);
    expect(earlier.at(-1)!).toBeGreaterThan(150);
    expect(new Set(picked).size).toBe(picked.length);
  });
  it('bounds a huge pool while keeping the newest passages', () => {
    const pool = Array.from({ length: 50 }, (_, i) => ({
      id: `s0p${i}`,
      text: '',
      cfi: '',
      sectionIndex: 0,
      label: '',
    }));
    thinRecapPool(pool, 20);
    expect(pool.length).toBeLessThanOrEqual(20);
    expect(pool.at(-1)?.id).toBe('s0p49');
  });
  it('never reads past the reader on a protected recap and reports the sampling', async () => {
    const f = fixture(['已读一', '已读二', '当前页', '未读剧透']);
    const result = await collectReadingContext({
      ...f,
      scope: 'read',
      sectionIndex: 2,
      isPdf: true,
      question: '前情提要',
      recap: true,
      spoilerProtection: true,
      signal: signal(),
    });
    expect(f.sections[3]!.createDocument).not.toHaveBeenCalled();
    expect(result.passages.map((p) => p.text)).toEqual(['已读一', '已读二', '当前页']);
    expect(result.passages.some((p) => p.text.includes('剧透'))).toBe(false);
  });
  it('warns when a long book is only sampled', async () => {
    const f = fixture(Array.from({ length: 40 }, (_, i) => `第${i}页内容`));
    const result = await collectReadingContext({
      ...f,
      scope: 'read',
      sectionIndex: 39,
      isPdf: true,
      question: 'x',
      recap: true,
      spoilerProtection: true,
      signal: signal(),
    });
    expect(result.passages).toHaveLength(RECAP_RECENT + RECAP_SAMPLED);
    expect(result.warnings.join('')).toContain('均匀抽样');
    expect(result.passages.at(-1)!.text).toBe('第39页内容');
  });
});

describe('local reading history', () => {
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    at: Date.now(),
    question: `问${id}`,
    answer: `答${id}`,
    scope: 'current',
    citations: [{ id: 's0p0', label: '物理页 1', cfi: 'cfi-1', sectionIndex: 0 }],
    ...extra,
  });
  it('round-trips, keeps citations and separates books', () => {
    const store = memoryStore();
    appendHistory('book-a', entry('1'), store);
    appendHistory('book-b', entry('2'), store);
    expect(loadHistory('book-a', store).map((e) => e.id)).toEqual(['1']);
    expect(loadHistory('book-a', store)[0]!.citations[0]!.cfi).toBe('cfi-1');
    expect(loadHistory('book-c', store)).toEqual([]);
  });
  it('replaces by id, caps entries and size, and drops uncitable citations', () => {
    const store = memoryStore();
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 10; i++) appendHistory('b', entry(String(i)), store);
    const all = loadHistory('b', store);
    expect(all).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(all.at(-1)!.id).toBe(String(HISTORY_MAX_ENTRIES + 9));
    appendHistory(
      'b',
      entry('x', { citations: [{ id: 'a', label: 'l', cfi: '', sectionIndex: 0 }] }),
      store,
    );
    expect(loadHistory('b', store).at(-1)!.citations).toEqual([]);
    const again = appendHistory('b', entry('x', { answer: '新答案' }), store);
    expect(again.filter((e) => e.id === 'x')).toHaveLength(1);
    expect(again.find((e) => e.id === 'x')!.answer).toBe('新答案');
    const big = memoryStore();
    for (let i = 0; i < 60; i++)
      appendHistory('big', entry(String(i), { answer: '长'.repeat(7000) }), big);
    expect(big.data.get('readest.readingHistory.v1.big')!.length).toBeLessThanOrEqual(400_000);
  });
  it('deletes one entry or the whole book, and survives corrupt storage', () => {
    const store = memoryStore();
    appendHistory('b', entry('1'), store);
    appendHistory('b', entry('2'), store);
    expect(deleteHistoryEntry('b', '1', store).map((e) => e.id)).toEqual(['2']);
    expect(deleteHistoryEntry('b', '2', store)).toEqual([]);
    expect(store.data.size).toBe(0);
    appendHistory('b', entry('3'), store);
    clearHistory('b', store);
    expect(loadHistory('b', store)).toEqual([]);
    store.data.set('readest.readingHistory.v1.bad', '{not json');
    expect(loadHistory('bad', store)).toEqual([]);
    store.data.set('readest.readingHistory.v1.worse', '[1,null,{"id":1}]');
    expect(loadHistory('worse', store)).toEqual([]);
    expect(loadHistory('b', null)).toEqual([]);
  });
});

describe('session-only confirmation consent', () => {
  it('is scoped to book, range, spoiler policy and destination, and never for whole-book', () => {
    clearAllConsent();
    const key = consentKey('h', 'current', true, 'https://x/y');
    expect(hasConsent(key)).toBe(false);
    setConsent(key, true);
    expect(hasConsent(key)).toBe(true);
    expect(hasConsent(consentKey('h', 'read', true, 'https://x/y'))).toBe(false);
    expect(hasConsent(consentKey('h', 'current', false, 'https://x/y'))).toBe(false);
    expect(hasConsent(consentKey('h', 'current', true, 'https://other'))).toBe(false);
    expect(hasConsent(consentKey('other', 'current', true, 'https://x/y'))).toBe(false);
    expect(canSkipConfirmation('all')).toBe(false);
    expect(canSkipConfirmation('current')).toBe(true);
    setConsent(key, false);
    expect(hasConsent(key)).toBe(false);
  });
});

describe('where you left off', () => {
  const point = { at: 1_000_000, cfi: 'epubcfi(/6/4)', label: '第三章', page: 42, fraction: 0.37 };
  it('round-trips a valid point and rejects malformed ones', () => {
    const store = memoryStore();
    expect(writeResume('h', point, store)).toBe(true);
    expect(readResume('h', store)).toEqual(point);
    store.data.set('readest.resume.v1.bad', JSON.stringify({ at: 'x', cfi: 1 }));
    expect(readResume('bad', store)).toBeNull();
    store.data.set('readest.resume.v1.nocfi', JSON.stringify({ at: 1, cfi: '' }));
    expect(readResume('nocfi', store)).toBeNull();
    store.data.set('readest.resume.v1.junk', '{');
    expect(readResume('junk', store)).toBeNull();
    expect(writeResume('h', { ...point, cfi: '' }, store)).toBe(false);
    expect(readResume('missing', store)).toBeNull();
    expect(readResume('h', null)).toBeNull();
  });
  it('welcomes you back only after a real break', () => {
    expect(shouldWelcomeBack(null)).toBe(false);
    expect(shouldWelcomeBack(point, point.at + RESUME_MIN_AWAY_MS - 1)).toBe(false);
    expect(shouldWelcomeBack(point, point.at + RESUME_MIN_AWAY_MS)).toBe(true);
  });
  it('describes how long ago in plain Chinese', () => {
    const min = 60_000;
    expect(formatAway(2 * min)).toBe('2 分钟前');
    expect(formatAway(5 * 60 * min)).toBe('5 小时前');
    expect(formatAway(3 * 24 * 60 * min)).toBe('3 天前');
    expect(formatAway(70 * 24 * 60 * min)).toBe('2 个月前');
    expect(describeResume(point, point.at + 3 * 24 * 60 * min)).toBe(
      '第三章 · 第 42 页 · 37% · 3 天前',
    );
  });
  it('freezes the position the book was opened at for the whole session', () => {
    const store = memoryStore();
    writeResume('abc', point, store);
    expect(captureOpenedResume('abc-view1', store)).toEqual(point);
    writeResume('abc', { ...point, cfi: 'epubcfi(/6/99)', at: point.at + 10 }, store);
    expect(captureOpenedResume('abc-view1', store)!.cfi).toBe('epubcfi(/6/4)');
    releaseOpenedResume('abc-view1');
    expect(captureOpenedResume('abc-view1', store)!.cfi).toBe('epubcfi(/6/99)');
    releaseOpenedResume('abc-view1');
  });
});
