// @vitest-environment node
/**
 * The 34-page real-world reflow test set (LaTeX manual, BERT, Attention, a
 * Chinese journal survey, a statistical communique, NIST SI brochure, Think
 * Python). The PDF is not stored in clear text: CI decrypts it and passes its
 * path in REFLOW_CORPUS_PDF. Without the file the suite is skipped.
 *
 * Every page must keep its text (nothing lost outside pictures, nothing
 * duplicated), carry no column warning, and meet the page's own reading
 * requirements listed below.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractPdfGraphics } from '@/utils/pdfReflowGraphics';
import { reflowPdfText, type ReflowPage, type PdfTextItem } from '@/utils/pdfReflow';
import { INLINE_EQUATION_MARK } from '@/utils/pdfReflowInline';

const FILE = process.env['REFLOW_CORPUS_PDF'] ?? '';
const root = path.resolve(__dirname, '../../../../../packages/foliate-js/node_modules/pdfjs-dist');

interface PageData {
  page: ReflowPage;
  items: PdfTextItem[];
  height: number;
}

// pdf.js objects are untyped here; only a few fields are read.
// biome-ignore lint/suspicious/noExplicitAny: pdf.js test harness
type Any = any;

async function load(): Promise<PageData[]> {
  const pdfjs = (await import(
    '../../../../../packages/foliate-js/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
  )) as Any;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(FILE)),
    useSystemFonts: true,
    disableFontFace: true,
    cMapUrl: `${root}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}/standard_fonts/`,
  }).promise;
  const pages: PageData[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x1, y1, x2, y2] = page.view as number[];
    const ops = await page.getOperatorList();
    // Same font table the reader builds in foliate's getReflowGraphics.
    const fonts: Record<string, string> = {};
    for (let k = 0; k < ops.fnArray.length; k++) {
      if (ops.fnArray[k] !== pdfjs.OPS.setFont) continue;
      const id = ops.argsArray[k]?.[0];
      if (typeof id !== 'string' || id in fonts) continue;
      try {
        fonts[id] = String(page.commonObjs.get(id)?.name ?? '').replace(/^[A-Z]{6}\+/, '');
      } catch {
        fonts[id] = '';
      }
    }
    const content = await page.getTextContent();
    const items: PdfTextItem[] = content.items
      .filter((item: Any) => typeof item.str === 'string')
      .map((item: Any) => ({
        str: item.str,
        width: item.width,
        height: item.height,
        transform: [
          ...item.transform.slice(0, 4),
          item.transform[4] - x1!,
          item.transform[5] - y1!,
        ],
        hasEOL: item.hasEOL,
        dir: item.dir,
        fontName: item.fontName,
      }));
    const graphics = extractPdfGraphics(
      { ...ops, fonts },
      pdfjs.OPS,
      [x1!, y1!],
      x2! - x1!,
      y2! - y1!,
    );
    pages.push({
      page: reflowPdfText(items, x2! - x1!, y2! - y1!, true, graphics),
      items,
      height: y2! - y1!,
    });
  }
  return pages;
}

const SCRIPTS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
  '⁼': '=',
  '⁽': '(',
  '⁾': ')',
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
  '₊': '+',
  '₋': '-',
  '₌': '=',
  '₍': '(',
  '₎': ')',
  '−': '-',
};
const chars = (text: string) =>
  Array.from(text.normalize('NFKC'))
    .map((ch) => SCRIPTS[ch] ?? ch)
    .filter(
      (ch) => !/\s/u.test(ch) && ch !== INLINE_EQUATION_MARK && ch !== '-' && ch !== '\u00ad',
    );
const count = (list: string[]) => {
  const map = new Map<string, number>();
  for (const ch of list) map.set(ch, (map.get(ch) ?? 0) + 1);
  return map;
};

/** Characters of text items whose centre is outside every picture block. */
function expectedChars(data: PageData): string[] {
  const figures = data.page.blocks.filter((b) => b.figure).map((b) => b.figure!);
  const inline = data.page.blocks.flatMap((b) => b.inline ?? []);
  const out: string[] = [];
  for (const item of data.items) {
    const [a, b, , d, x, y] = item.transform as number[];
    const size = Math.hypot(item.transform[2]!, d!);
    const rotated = Math.abs(Math.atan2(b!, a!)) > 0.12;
    const cx = x! + (rotated ? 0 : item.width / 2);
    const cy = y! + size * 0.3;
    const inPicture = [...figures, ...inline].some(
      (r) => cx >= r.x0 - 1 && cx <= r.x1 + 1 && cy >= r.y0 - 1 && cy <= r.y1 + 1,
    );
    if (!inPicture) out.push(...chars(item.str));
  }
  for (const removed of data.page.removedPageNumbers)
    for (const ch of chars(removed)) {
      const i = out.indexOf(ch);
      if (i >= 0) out.splice(i, 1);
    }
  return out;
}

const shown = (data: PageData) => chars(data.page.blocks.map((b) => b.text).join(''));
const blocks = (data: PageData, kind: string) => data.page.blocks.filter((b) => b.kind === kind);
const textOf = (data: PageData) => data.page.blocks.map((b) => b.text);

// CI sets REFLOW_CORPUS_PDF; a path that does not exist there is a failure,
// not a skip. Locally the suite is skipped when no path is given.
describe.skipIf(!FILE)('reflow test set (34 real pages)', () => {
  it('has the test set file', () => {
    expect(fs.existsSync(FILE)).toBe(true);
  });
  let pages: PageData[] = [];
  const page = (n: number) => pages[n - 1]!;

  it('loads all 34 pages', async () => {
    pages = await load();
    expect(pages).toHaveLength(34);
  }, 120_000);

  it('loses no text outside pictures and duplicates nothing', () => {
    const problems: string[] = [];
    pages.forEach((data, i) => {
      const want = count(expectedChars(data));
      const got = count(shown(data));
      let lost = '';
      let extra = '';
      for (const [ch, n] of want)
        if ((got.get(ch) ?? 0) < n) lost += ch.repeat(n - (got.get(ch) ?? 0));
      for (const [ch, n] of got)
        if ((want.get(ch) ?? 0) < n) extra += ch.repeat(n - (want.get(ch) ?? 0));
      // Known, reviewed differences:
      // p9  a tall | and ‖ are each drawn as two stacked glyph pieces; one
      //     character is shown.
      // p19 the labels "h" and "V K Q" of the attention diagram are printed a
      //     point outside its bitmap; they belong to the picture, so they are
      //     not shown as text (V, K, Q are the only characters not counted
      //     as picture text by the check above).
      const allowed: Record<number, [string, string]> = { 9: ['∣∥', ''], 19: ['VKQ', ''] };
      const ok = allowed[i + 1];
      if (ok && lost === ok[0] && extra === ok[1]) return;
      if (lost || extra)
        problems.push(`page ${i + 1}: lost "${lost.slice(0, 40)}" extra "${extra.slice(0, 40)}"`);
    });
    expect(problems).toEqual([]);
  });

  it('never claims an unrecognised multi-column layout', () => {
    const warned = pages
      .map((data, i) => (data.page.warnings.includes('possible-multiple-columns') ? i + 1 : 0))
      .filter(Boolean);
    expect(warned).toEqual([]);
  });

  // ---- LaTeX manual (pages 1-9): side-by-side source and result boxes ----
  it('p2: a source box and its result box are read separately, not line by line', () => {
    const code = blocks(page(2), 'code').map((b) => b.text);
    expect(code).toContain(
      "A reference to this subsection\n\\label{sec:this} looks like:\n``see section~\\ref{sec:this} on\npage~\\pageref{sec:this}.''",
    );
    expect(textOf(page(2))).toContain(
      'A reference to this subsection looks like: “see section 3.3 on page 22.”',
    );
  });
  it('p3: the margin note is one note and the sentence beside it stays in the text', () => {
    expect(blocks(page(3), 'note').map((b) => b.text)).toContain(
      '边注较窄，不要写过多文字。最好设置较小的字号。',
    );
    expect(textOf(page(3)).some((t) => t.endsWith('其效果见边栏。'))).toBe(true);
  });
  // The sample sentence and the footnote text are set in a CJK text font
  // inside the typewriter listing; they belong to the listing all the same.
  it('p3: the footnotemark listing is one code block, CJK lines included', () => {
    expect(blocks(page(3), 'code').map((b) => b.text)).toContain(
      '\\begin{tabular}{l}\n\\hline\n“天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。”\\footnotemark \\\\\n\\hline\n\\end{tabular}\n\\footnotetext{表格里的名句出自《千字文》。}',
    );
    expect(textOf(page(3))).not.toContain('\\footnotetext{表格里的名句出自《千字文》。}');
  });
  it('p3: a nested list listing keeps lines and indentation and is not a table', () => {
    expect(blocks(page(3), 'cell')).toHaveLength(0);
    expect(blocks(page(3), 'code').map((b) => b.text)).toContain(
      '\\begin{enumerate}\n  \\item An item.\n  \\begin{enumerate}\n    \\item A nested item.\\label{itref}\n    \\item[*] A starred item.\n  \\end{enumerate}\n  \\item Reference(\\ref{itref}).\n\\end{enumerate}',
    );
  });
  it('p4: tabular sources stay whole; their result tables follow them', () => {
    const code = blocks(page(4), 'code').map((b) => b.text);
    expect(code).toContain(
      '\\begin{tabular}{lcr|p{6em}}\n  \\hline\n  left & center & right\n       & par box with fixed width\\\\\n  L & C & R & P \\\\\n \\hline\n\\end{tabular}',
    );
    expect(code).toContain(
      '\\begin{tabular}{|c|c|c|c|c|p{4em}|p{4em}|}\n\\begin{tabular}{|*{5}{c|}*{2}{p{4em}|}}',
    );
  });
  it('p5: the nested table result keeps its spans', () => {
    const spans = blocks(page(5), 'cell').filter(
      (b) => b.table!.rowSpan > 1 || b.table!.colSpan > 1,
    );
    expect(spans.length).toBeGreaterThanOrEqual(4);
  });
  it('pp6-9: typeset math results are pictures, never loose glyphs or tables', () => {
    for (const n of [6, 7, 8, 9]) {
      expect(blocks(page(n), 'cell'), `page ${n}`).toHaveLength(0);
      expect(blocks(page(n), 'figure').length, `page ${n}`).toBeGreaterThanOrEqual(3);
      // No private-use delimiter fragments (big braces/parentheses) as text.
      expect(
        page(n).page.blocks.some((b) => /[\ue000-\uf8ff]/u.test(b.text)),
        `page ${n}`,
      ).toBe(false);
    }
  });
  it('p6: section numbers stay with their headings', () => {
    expect(textOf(page(6))).toContain('4.3.4关系符');
  });

  // ---- BERT (pages 10-14): two columns ----
  it('p10: title, authors, affiliation and e-mail are separate lines', () => {
    const t = textOf(page(10));
    expect(t.some((x) => x === 'Google AI Language')).toBe(true);
    expect(t.some((x) => /^\{jacobdevlin,[^}]+\}@google\.com$/.test(x))).toBe(true);
    expect(t.some((x) => x.startsWith('Jacob Devlin') && x.includes('Toutanova') && !x.includes('Google'))).toBe(true);
    // The wrapped two-line title stays one block.
    expect(t.some((x) => x.startsWith('BERT: Pre-training') && x.includes('Language Understanding'))).toBe(true);
  });
  it('p28: footnotes (a) to (i) are nine separate notes', () => {
    const marked = textOf(page(28)).filter((x) => /^\([a-i]\) /.test(x));
    expect(marked.map((x) => x.slice(0, 3))).toEqual(
      ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)', '(h)', '(i)'],
    );
    // No note swallows the next marker.
    expect(textOf(page(28)).some((x) => /\S \([b-i]\) [A-Z]/.test(x))).toBe(false);
  });
  it('p10: the abstract and the introduction read as whole paragraphs', () => {
    const abstract = textOf(page(10)).find((t) => t.startsWith('We introduce a new language'));
    expect(abstract).toContain(
      'representation model called BERT, which stands for Bidirectional Encoder',
    );
    expect(abstract).toContain('SQuAD v2.0 Test F1 to 83.1 (5.1 point absolute improvement).');
    // The rotated arXiv side label never interrupts a sentence.
    expect(textOf(page(10)).at(-1)).toBe('arXiv:1810.04805v2 [cs.CL] 24 May 2019');
    expect(
      textOf(page(10)).some((t) =>
        t.includes('feature-based and fine-tuning. The feature-based approach'),
      ),
    ).toBe(true);
  });
  it('p11: Figure 1 is a picture, and the right column follows the left', () => {
    expect(blocks(page(11), 'cell')).toHaveLength(0);
    expect(blocks(page(11), 'figure')).toHaveLength(1);
    const texts = textOf(page(11));
    const left = texts.findIndex((t) => t.startsWith('3 BERT'));
    const right = texts.findIndex((t) => t.startsWith('Model Architecture'));
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeGreaterThan(left);
  });
  it('p12: the softmax over all words is one inline picture', () => {
    const block = page(12).page.blocks.find((b) =>
      b.text.includes('softmax over all of the words'),
    );
    expect(block?.inline?.length).toBeGreaterThanOrEqual(1);
  });
  it('p13: all three tables are tables, each numeric value in its own cell', () => {
    const ids = new Set(blocks(page(13), 'cell').map((b) => b.table!.id));
    expect(ids.size).toBe(3);
    expect(blocks(page(13), 'cell').some((b) => /\d+\.\d\s+\d+\.\d/u.test(b.text))).toBe(false);
  });
  it('p14: references are whole entries, one per block', () => {
    const texts = textOf(page(14));
    expect(texts).toContain(
      'Z. Chen, H. Zhang, X. Zhang, and L. Zhao. 2018. Quora question pairs.',
    );
    expect(
      texts.some((t) =>
        t.startsWith('Kevin Clark, Minh-Thang Luong, Christopher D Manning, and Quoc Le. 2018.'),
      ),
    ).toBe(true);
  });

  // ---- Attention (pages 15-17) ----
  it('p15-16: display formulas are pictures', () => {
    expect(
      blocks(page(15), 'figure').filter((b) => b.figure!.bodySize).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      blocks(page(16), 'figure').filter((b) => b.figure!.bodySize).length,
    ).toBeGreaterThanOrEqual(1);
    expect(textOf(page(16)).some((t) => t.includes('100002i'))).toBe(false);
  });
  it('p17: Table 2 is a table and exponents stay exponents', () => {
    const cells = blocks(page(17), 'cell').map((b) => b.text);
    expect(cells).toContain('2.3 · 10¹⁹');
    expect(cells).toContain('1.4 · 10²⁰');
  });

  // ---- Chinese survey (pages 18-21) ----
  it('p18: the timeline picture text is not repeated in the flow', () => {
    expect(textOf(page(18)).some((t) => t.includes('1966 2003 2018'))).toBe(false);
  });
  // Running heads repeat on every page; they are not text of the page.
  it('running heads and feet are taken out on every page that has one', () => {
    const heads: Record<number, string> = {
      2: '第三章',
      3: '特殊环境',
      4: '第三章',
      5: '表格',
      6: '第四章',
      7: '第四章',
      8: '数组和矩阵',
      9: '第四章',
      18: '软件学报',
      19: '软件学报',
      20: '刘澳迪',
      21: '软件学报',
      30: 'Composition',
      31: 'Stack diagrams',
      32: 'Recursion',
      33: 'Fruitful functions',
      34: 'Named tuples',
    };
    for (const [n, word] of Object.entries(heads)) {
      const data = page(Number(n));
      const removed = data.page.removedPageNumbers.filter((t) => t.includes(word));
      expect(removed, `page ${n}`).toHaveLength(1);
      // The head must not also stay in the text as a block of its own. (The
      // word itself may occur in the body, e.g. a section titled the same.)
      const copy = textOf(data).filter((t) => chars(t).join('') === chars(removed[0]!).join(''));
      expect(copy, `page ${n}`).toEqual([]);
    }
  });
  it('p19: the "h" and "V K Q" labels of the attention diagram belong to the picture', () => {
    const all = textOf(page(19));
    expect(all).not.toContain('h');
    expect(all).not.toContain('V K Q');
    expect(blocks(page(19), 'note')).toHaveLength(0);
  });
  it('p19: the loss formulas are pictures', () => {
    expect(
      blocks(page(19), 'figure').filter((b) => b.figure!.bodySize).length,
    ).toBeGreaterThanOrEqual(2);
  });
  it('p20: Table 4 is one table with spanning task labels and whole cells', () => {
    const cells = blocks(page(20), 'cell');
    expect(new Set(cells.map((b) => b.table!.id)).size).toBe(1);
    expect(cells.find((b) => b.text === '代码生成')?.table?.rowSpan).toBeGreaterThan(4);
    expect(cells.map((b) => b.text)).toContain('REDCODER[67]');
    expect(cells.map((b) => b.text)).toContain(
      '通过检索增强机制有效模拟开发者代码复用行为,在代码生成与摘要任务中展现出实用性和性能优势',
    );
  });

  // ---- Statistical communique (pages 22-25) ----
  it('p22: the three charts are pictures', () => {
    expect(blocks(page(22), 'figure')).toHaveLength(3);
  });
  it('p23: the population table is a table', () => {
    expect(blocks(page(23), 'cell').length).toBeGreaterThanOrEqual(24);
  });
  it('p25: notes [1]-[11] are separate blocks', () => {
    const notes = textOf(page(25)).filter((t) => /^\[\d+\]/u.test(t));
    expect(notes).toHaveLength(11);
  });

  // ---- NIST SI brochure (pages 26-29) ----
  it('p26: the definition formula is a picture, not a table', () => {
    expect(new Set(blocks(page(26), 'cell').map((b) => b.table!.id)).size).toBe(1);
    expect(blocks(page(26), 'figure').filter((b) => b.figure!.bodySize)).toHaveLength(1);
  });
  it('p27-29: unit exponents are superscripts', () => {
    expect(blocks(page(27), 'cell').map((b) => b.text)).toContain('Pa = kg m⁻¹ s⁻²');
    expect(page(29).page.blocks.some((b) => b.text.includes('1 t = 10³ kg'))).toBe(true);
  });

  // ---- Think Python (pages 30-34): unshaded code ----
  it('pp30-34: code keeps its lines and indentation and never joins prose', () => {
    const code = (n: number) => blocks(page(n), 'code').map((b) => b.text);
    expect(code(30)).toContain(
      'def print_lyrics():\n    print("I\'m a lumberjack, and I\'m okay.")\n    print("I sleep all night and I work all day.")',
    );
    expect(code(32)).toContain(
      "def countdown(n):\n    if n <= 0:\n        print('Blastoff!')\n    else:\n        print(n)\n        countdown(n-1)",
    );
    expect(code(33)).toContain(
      'def fibonacci(n):\n    if n == 0:\n        return 0\n    elif n == 1:\n        return 1\n    else:\n        return fibonacci(n-1) + fibonacci(n-2)',
    );
    expect(
      code(31).some((t) =>
        t.startsWith('Traceback (innermost last):\n  File "test.py", line 13, in __main__'),
      ),
    ).toBe(true);
    for (const n of [30, 31, 32, 33, 34])
      expect(blocks(page(n), 'cell'), `page ${n}`).toHaveLength(0);
  });
  it('p31: the stack diagram is one picture with its frame names', () => {
    expect(blocks(page(31), 'figure')).toHaveLength(1);
    expect(textOf(page(31)).some((t) => t === '__main__' || t === 'cat_twice')).toBe(false);
  });
});
