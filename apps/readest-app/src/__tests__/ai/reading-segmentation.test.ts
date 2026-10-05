import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bm25,
  chineseSegmenter,
  collectReadingContext,
  queryTerms,
  resetChineseSegmenter,
  termFrequencies,
} from '@/services/ai/readingContext';
import type { BookDoc, SectionItem } from '@/libs/document';
import type { FoliateView } from '@/types/view';

/** Deterministic dictionary segmenter, so these tests do not depend on the
 * ICU data the test runner's Node happens to ship with. */
function dictSegmenter(words: string[]) {
  const dict = [...words].sort((a, b) => b.length - a.length);
  return {
    segment(text: string) {
      const out: { segment: string; isWordLike: boolean }[] = [];
      let i = 0;
      while (i < text.length) {
        const hit = dict.find((w) => text.startsWith(w, i));
        const segment = hit ?? text[i]!;
        out.push({ segment, isWordLike: true });
        i += segment.length;
      }
      return out;
    },
  };
}
const DICT = [
  '冰块',
  '融化',
  '为什么',
  '面积',
  '体积',
  '关系',
  '什么',
  '作者',
  '怎么',
  '解释',
  '巨人',
  '不可能',
  '存在',
  '复利',
  '效应',
  '意思',
  '这段',
  '多元',
  '思维',
  '模型',
  '恐龙',
  '躯体',
];

afterEach(() => resetChineseSegmenter(undefined));

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
  return { view, bookDoc };
}
const signal = () => new AbortController().signal;

describe('Chinese word segmentation for local retrieval', () => {
  it('drops question words and particles that say nothing about the book', () => {
    resetChineseSegmenter(dictSegmenter(DICT));
    const terms = queryTerms('作者怎么解释巨人不可能存在');
    expect(terms).toEqual(expect.arrayContaining(['巨人', '不可能', '存在']));
    for (const noise of ['作者', '怎么', '解释', '者怎', '么解', '释巨'])
      expect(terms).not.toContain(noise);
    const why = queryTerms('为什么冰块融化得快？');
    expect(why).toEqual(expect.arrayContaining(['冰块', '融化']));
    expect(why).not.toContain('什么');
    expect(why).not.toContain('融化得');
  });
  it('re-joins a compound the dictionary splits and keeps its parts', () => {
    resetChineseSegmenter(dictSegmenter(DICT));
    // 表 is not a dictionary word here, exactly like ICU's 表|面积.
    const terms = queryTerms('表面积和体积的关系是什么');
    expect(terms).toEqual(expect.arrayContaining(['表面积', '面积', '体积', '关系']));
    expect(terms).not.toContain('积和');
    expect(terms).not.toContain('是什');
  });
  it('glues an unknown name split into single characters', () => {
    resetChineseSegmenter(dictSegmenter(DICT));
    expect(queryTerms('芒格的多元思维模型')).toEqual(
      expect.arrayContaining(['芒格', '多元', '思维', '模型', '多元思维', '思维模型']),
    );
  });
  it('keeps a lone content character and falls back to bigrams when nothing is left', () => {
    resetChineseSegmenter(dictSegmenter(DICT));
    expect(queryTerms('冰')).toEqual(['冰']);
    expect(queryTerms('什么是什么').length).toBeGreaterThan(0);
  });
  it('still extracts English terms alongside Chinese words', () => {
    resetChineseSegmenter(dictSegmenter(DICT));
    expect(queryTerms('复利效应 compound interest')).toEqual(
      expect.arrayContaining(['compound', 'interest', '复利', '效应', '复利效应']),
    );
  });
  it('a segmenter that cannot split Chinese (small ICU) is treated as absent', () => {
    const whole = { segment: (t: string) => [{ segment: t, isWordLike: true }] };
    const spy = vi
      .spyOn(Intl, 'Segmenter')
      .mockImplementation(() => whole as unknown as Intl.Segmenter);
    try {
      resetChineseSegmenter(undefined);
      expect(chineseSegmenter()).toBeNull();
      expect(queryTerms('知识判断')).toEqual(['知识', '识判', '判断']);
    } finally {
      spy.mockRestore();
      resetChineseSegmenter(undefined);
    }
  });
  it('question noise no longer outranks the passage that answers it', () => {
    // A passage full of 什么/作者 used to collect hits from the noise bigrams.
    const noisy = '作者说什么呢？作者说什么呢？作者说什么呢？这里什么也没说。';
    const answer = '巨人不可能存在，因为骨骼承重随横截面增长，体重随体积增长。';
    const question = '作者说巨人为什么不可能存在？';
    resetChineseSegmenter(null);
    const bi = queryTerms(question);
    const biScores = bm25(
      [noisy, answer].map((t) => ({ tf: termFrequencies(t, bi), len: t.length })),
      { count: 2, length: noisy.length + answer.length },
    );
    resetChineseSegmenter(dictSegmenter(DICT));
    const seg = queryTerms(question);
    const segScores = bm25(
      [noisy, answer].map((t) => ({ tf: termFrequencies(t, seg), len: t.length })),
      { count: 2, length: noisy.length + answer.length },
    );
    expect(biScores[0]!).toBeGreaterThan(0); // the old behaviour: noise scored
    expect(segScores[0]!).toBe(0);
    expect(segScores[1]!).toBeGreaterThan(0);
  });
  it('end to end: the answering section wins over a section of question-like chatter', async () => {
    resetChineseSegmenter(dictSegmenter(DICT));
    const f = fixture([
      '为什么？为什么？作者在这里反复追问为什么，却什么也没有解释。',
      '冰块越小，单位体积的表面积越大，因此融化得越快。',
    ]);
    const result = await collectReadingContext({
      ...f,
      scope: 'all',
      sectionIndex: 0,
      isPdf: false,
      question: '作者解释过为什么冰块融化得快吗？',
      spoilerProtection: false,
      signal: signal(),
    });
    expect(result.passages[0]!.text).toContain('冰块越小');
    expect(result.passages.every((p) => !p.text.startsWith('为什么？'))).toBe(true);
  });
  it('real Intl.Segmenter, when this runtime has full ICU data', () => {
    resetChineseSegmenter(undefined);
    if (!chineseSegmenter()) return; // small-ICU Node: covered by the stubs above
    const terms = queryTerms('表面积和体积的关系是什么');
    expect(terms).toEqual(expect.arrayContaining(['表面积', '体积', '关系']));
    expect(terms).not.toContain('什么');
  });
});
