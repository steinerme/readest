import type { PdfGraphics, Rect } from './pdfReflowGraphics';
import { INLINE_EQUATION_MARK, findInlineEquations, type InlineEquation } from './pdfReflowInline';
import { textFormulaRegions } from './pdfReflowFormula';
import { findInlineTextFormulas } from './pdfReflowInlineText';
import { assignRegions, regionAt, textBoxes, type Region } from './pdfReflowRegions';
import {
  analyzeLayout,
  detectAlignedTables,
  detectSparseTables,
  type TableModel,
} from './pdfReflowLayout';
import {
  buildLines,
  fontClass,
  joinLineRuns,
  joinLines,
  joinMapped,
  median,
  textSize,
  type Line,
  type Run,
} from './pdfReflowLines';

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  dir?: string;
  /** pdf.js font id; resolved to a real name through `graphics.fonts`. */
  fontName?: string;
}

export interface ReflowTableCell {
  /** Stable id shared by all cells of one table. */
  id: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  header: boolean;
  rows: number;
  cols: number;
  numeric: boolean;
}

export interface ReflowFigure {
  /** PDF user-space rectangle relative to the page view origin (y up). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Body text size of the page in PDF units. A picture of an equation is shown
   * at `size / bodySize` times the reading font size so its symbols match the
   * surrounding text instead of shrinking with the page. */
  bodySize?: number;
}

export interface ReflowBlock {
  /** `cell` blocks are table cells: one block per cell so every index-based
   * service (speech highlight, selection, citation) keeps working unchanged.
   * `figure` blocks have no text; the page region is rendered as a picture.
   * `code` blocks keep their line breaks (\n) and leading indentation. */
  kind: 'paragraph' | 'note' | 'cell' | 'figure' | 'code';
  text: string;
  table?: ReflowTableCell;
  figure?: ReflowFigure;
  /** Inline equations drawn as vector outlines. Each one stands at a
   * `INLINE_EQUATION_MARK` character in `text`, in order. */
  inline?: InlineEquation[];
}

export interface ReflowPage {
  blocks: ReflowBlock[];
  /** Page numbers and running heads/feet taken out of the text. */
  removedPageNumbers: string[];
  warnings: string[];
  /** Optional local-only provenance: normalized PDF item stream and, per block,
   * the source character offset for every displayed UTF-16 character (-1 = spacing). */
  sourceText?: string;
  sourceMap?: number[][];
  /** Page size in PDF units, needed to render figure regions. */
  pageWidth?: number;
  pageHeight?: number;
}

export const normalizePdfSpeechText = (text: string) =>
  text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');

const NUMERIC_CELL = /^[\s\d.,:%$¥€£+\-−–()/]+$/u;

interface Entry {
  block: ReflowBlock;
  source: number[];
  top: number;
  order: number;
  /** Reading-order position of the region group this entry belongs to. */
  groupTop?: number;
  groupX?: number;
  /** Page area of a table this cell belongs to. */
  rect?: Rect;
}

function tableEntries(
  table: TableModel,
  id: number,
  pageWidth: number,
  next: () => number,
): Entry[] {
  const entries: Entry[] = [];
  const cells = [...table.cells].sort((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of cells) {
    const { lines } = buildLines(cell.runs, pageWidth);
    const joined = joinLines(lines);
    const text = joined.text.trim() ? joined.text : '';
    // Cell text is trimmed here; keep the source map aligned with it.
    const lead = joined.text.length - joined.text.trimStart().length;
    const source = joined.source.slice(lead, lead + text.trimEnd().length);
    entries.push({
      block: {
        kind: 'cell',
        text: text.trim(),
        table: {
          id,
          row: cell.row,
          col: cell.col,
          rowSpan: cell.rowSpan,
          colSpan: cell.colSpan,
          header: cell.header,
          rows: table.rows,
          cols: table.cols,
          numeric: !!text && NUMERIC_CELL.test(text) && /\d/u.test(text),
        },
      },
      source: text ? source.slice(0, text.trim().length) : [],
      top: table.rect.y1,
      order: next(),
      rect: table.rect,
    });
  }
  return entries;
}

const textLength = (runs: Run[]) => runs.reduce((n, run) => n + run.text.trim().length, 0);

/**
 * A short piece of text tilted off the page axes is a watermark ("DRAFT",
 * "SAMPLE COPY"), not reading content. It is removed only when the page also
 * has far more upright text, so a page that is mostly diagonal text (a scanned
 * or rotated page) keeps everything. Vertical sidebars are not diagonal.
 */
function dropDiagonalWatermark(runs: Run[], warn: (code: string) => void) {
  const diagonal = runs.filter((run) => run.diagonal);
  if (!diagonal.length) return;
  const upright = textLength(runs.filter((run) => !run.rotated));
  const stamped = textLength(diagonal);
  if (stamped > 80 || upright < stamped * 4) return;
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i]!.diagonal) runs.splice(i, 1);
  warn('watermark-text-dropped');
}

const BULLET_MARK = /^(?:[•·●○▪◦‣∙■□◆◇▶▸➢➤*]|[-–—]\s)\s*\S/u;
const NUMBER_MARK =
  /^(?:\d{1,2}[.)](?:\s|(?=\p{Script=Han}))|[（(]\d{1,2}[）)]\s*|\d{1,2}[、．]\s*)\S/u;
const SENTENCE_END = /[.。;；:：!?！？)）]$/u;
// Lettered or roman notes "(a) ", "(iv) " (SI table notes, legal clauses).
const LETTER_MARK = /^\((?:[a-z]|[ivx]{2,4})\)\s+\S/u;

/** The font that carries most of a line's characters (empty when unknown). */
function mainFont(line: Line): string {
  const share = new Map<string, number>();
  for (const run of line.runs) {
    const name = run.fontName ?? '';
    share.set(name, (share.get(name) ?? 0) + run.text.trim().length);
  }
  let best = '';
  let most = -1;
  for (const [name, n] of share)
    if (n > most) {
      best = name;
      most = n;
    }
  return best;
}

/**
 * Centred lines that differ in font and start at different places (authors,
 * affiliation, e-mail under a title) are separate lines, not the wrapped lines
 * of one paragraph. A wrapped centred title has the same font on every line,
 * and wrapped body lines share a left edge, so neither is split.
 */
function centredApart(line: Line, previous: Line | undefined): boolean {
  if (!previous) return false;
  const centre = (l: Line) => (l.x + l.end) / 2;
  const fontA = mainFont(line);
  const fontB = mainFont(previous);
  return (
    !!fontA &&
    !!fontB &&
    fontA !== fontB &&
    Math.abs(centre(line) - centre(previous)) <= 2 &&
    Math.abs(line.x - previous.x) >= Math.max(line.size, previous.size) * 1.5
  );
}

/**
 * A new list item starts a new block. Bullets always do; numbered markers only
 * after a finished sentence or another item, so a wrapped line that happens to
 * begin with "2020) " or "3. " inside a sentence is not split.
 */
export function startsListItem(
  line: string,
  previous: string | undefined,
  /** The line starts left of the previous one: a hanging-indent marker. */
  outdented = false,
): boolean {
  const text = line.trimStart();
  if (BULLET_MARK.test(text)) return true;
  // A lettered note opens a new item after a finished sentence, or when its
  // marker hangs out to the left of the wrapped lines above it.
  if (LETTER_MARK.test(text) && previous !== undefined) {
    return outdented || SENTENCE_END.test(previous.trimEnd());
  }
  if (!NUMBER_MARK.test(text) || previous === undefined) return false;
  const before = previous.trimEnd();
  return SENTENCE_END.test(before) || BULLET_MARK.test(before) || NUMBER_MARK.test(before);
}

/**
 * Some books draw list bullets as tiny vector discs instead of text glyphs. A
 * line starts a list item when a small, roughly square shape sits just left of
 * its first character and level with its first row. Shapes inside tables or
 * figures never reach here (their runs are consumed), and a dot must be well
 * smaller than the text, so rules, boxes and diagram nodes do not qualify.
 */
function vectorBullets(
  lines: Line[],
  graphics: PdfGraphics | undefined,
  bodySize: number,
  /** Where a line really starts when it opens with an inline equation. */
  leftEdge?: Map<Line, number>,
) {
  const found = { lines: new Set<Line>(), shapes: new Set<Rect>() };
  if (!graphics?.shapes.length) return found;
  const dots = graphics.shapes.filter((shape) => {
    const w = shape.x1 - shape.x0;
    const h = shape.y1 - shape.y0;
    return (
      w >= 1.5 &&
      h >= 1.5 &&
      w <= bodySize * 0.8 &&
      h <= bodySize * 0.8 &&
      Math.abs(w - h) <= Math.max(w, h) * 0.35
    );
  });
  for (const line of lines) {
    for (const dot of dots) {
      const gap = Math.min(line.x, leftEdge?.get(line) ?? Infinity) - dot.x1;
      const mid = (dot.y0 + dot.y1) / 2;
      // A disc well left of the first character is a bullet; a symbol set
      // against the text is part of an equation.
      if (
        gap >= line.size * 0.4 &&
        gap <= line.size * 2.5 &&
        mid >= line.y - line.size * 0.15 &&
        mid <= line.y + line.size * 0.95
      ) {
        found.lines.add(line);
        found.shapes.add(dot);
      }
    }
  }
  return found;
}

/**
 * Re-join one line with an invisible marker where each inline equation sits.
 * Words are positioned by geometry, so the marker goes between the last run
 * that ends before the equation and the first that starts after it.
 */
function joinLineWithEquations(
  line: Line,
  equations: InlineEquation[],
): { text: string; source: number[] } | null {
  const runs = [...line.runs].sort((a, b) => a.x - b.x);
  const parts: Run[] = [];
  let next = 0;
  const markRun = (equation: InlineEquation): Run => ({
    text: INLINE_EQUATION_MARK,
    source: [-1],
    x: equation.x0,
    y: line.y,
    size: line.size,
    width: equation.x1 - equation.x0,
    rotated: false,
  });
  for (const run of runs) {
    while (next < equations.length && equations[next]!.x0 < run.x + run.width / 2) {
      parts.push(markRun(equations[next]!));
      next += 1;
    }
    parts.push(run);
  }
  while (next < equations.length) parts.push(markRun(equations[next++]!));
  const joined = joinLineRuns(parts, line.size);
  if ((joined.text.match(new RegExp(INLINE_EQUATION_MARK, 'gu')) ?? []).length !== equations.length)
    return null;
  return joined;
}

/**
 * Conservative, dependency-free reflow for horizontal pages.
 * Coordinates are unmodified PDF coordinates (larger baseline y is higher).
 * Warnings are stable codes: empty-text, rotated-text,
 * possible-multiple-columns, invalid-text-item. Suspected columns are retained
 * in visual row order, not silently discarded or claimed to be fully reflowed.
 *
 * When `graphics` (bitmaps, rules, vector shapes) is supplied, tables and
 * figures are recognised and emitted as `cell` / `figure` blocks in reading
 * order; without it the behaviour is the text-only reflow.
 */
export function reflowPdfText(
  items: PdfTextItem[],
  pageWidth: number,
  pageHeight: number,
  withSourceMap = false,
  graphics?: PdfGraphics,
): ReflowPage {
  const result: ReflowPage = { blocks: [], removedPageNumbers: [], warnings: [] };
  let sourceText = '';
  const blockSources: number[][] = [];
  if (withSourceMap) {
    result.sourceMap = blockSources;
    result.sourceText = '';
  }
  const warn = (code: string) => {
    if (!result.warnings.includes(code)) result.warnings.push(code);
  };
  const allRuns: Run[] = [];
  for (const item of items) {
    const source: number[] = [];
    let text = '';
    for (const char of item.str) {
      const normalized = normalizePdfSpeechText(char);
      const offset = sourceText.length;
      sourceText += normalized;
      const display = /\s/u.test(char) ? ' ' : char;
      if (display === ' ' && text.endsWith(' ')) continue;
      text += display;
      for (let i = 0; i < display.length; i++) source.push(normalized ? offset : -1);
    }
    if (withSourceMap) result.sourceText = sourceText;
    if (!item.str.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    if (item.transform.length < 6 || ![a, b, c, d, x, y, item.width].every(Number.isFinite)) {
      warn('invalid-text-item');
      continue;
    }
    // height can be a glyph bounding box and is especially unreliable for italics.
    const size = Math.hypot(c!, d!);
    if (size <= 0) {
      warn('invalid-text-item');
      continue;
    }
    const rotated = Math.abs(Math.atan2(b!, a!)) > 0.12 || item.dir === 'ttb';
    if (rotated) warn('rotated-text');
    const angle = Math.abs((Math.atan2(b!, a!) * 180) / Math.PI) % 90;
    const diagonal = rotated && item.dir !== 'ttb' && Math.min(angle, 90 - angle) > 3;
    const fontName = item.fontName ? graphics?.fonts?.[item.fontName] || undefined : undefined;
    const font = fontClass(fontName);
    allRuns.push({
      text,
      source,
      x: x!,
      y: y!,
      size,
      width: Math.abs(item.width),
      rotated,
      diagonal,
      ...(font ? { font } : {}),
      ...(fontName ? { fontName } : {}),
    });
  }
  dropDiagonalWatermark(allRuns, warn);

  const layout = analyzeLayout(allRuns, graphics, pageWidth, pageHeight);
  const runs = layout.flowRuns;
  const entries: Entry[] = [];
  let order = 0;
  const nextOrder = () => order++;
  // A framed box of typeset output holding math (a LaTeX manual's "result"
  // box beside its source) is shown as a picture of the box: its formulas,
  // fractions and matrices cannot be rebuilt from loose glyphs.
  const mathBoxes = textBoxes(
    graphics,
    allRuns.filter((run) => !run.rotated),
    pageWidth,
    pageHeight,
    layout.bodySize || 10,
  ).filter((box) => {
    if (box.shaded) return false;
    // A cell of a ruled table is not a stand-alone result box: a table cell
    // shares its edges with neighbouring cells.
    // Its top or bottom rule continues past the box's side (into the next
    // cell), or its side rule continues past its top or bottom.
    const shared = (graphics?.segments ?? []).filter((seg) => {
      const sx0 = Math.min(seg.x0, seg.x1);
      const sx1 = Math.max(seg.x0, seg.x1);
      const sy0 = Math.min(seg.y0, seg.y1);
      const sy1 = Math.max(seg.y0, seg.y1);
      if (sy1 - sy0 < 0.5) {
        const onEdge = Math.abs(sy0 - box.y0) < 2 || Math.abs(sy0 - box.y1) < 2;
        const beyond =
          (sx1 <= box.x0 + 2 && sx1 >= box.x0 - 2 && sx0 < box.x0 - 4) ||
          (sx0 >= box.x1 - 2 && sx0 <= box.x1 + 2 && sx1 > box.x1 + 4);
        return onEdge && beyond;
      }
      const onEdge = Math.abs(sx0 - box.x0) < 2 || Math.abs(sx0 - box.x1) < 2;
      const beyond =
        (sy1 <= box.y0 + 2 && sy1 >= box.y0 - 2 && sy0 < box.y0 - 4) ||
        (sy0 >= box.y1 - 2 && sy0 <= box.y1 + 2 && sy1 > box.y1 + 4);
      return onEdge && beyond;
    }).length;
    if (shared >= 2) return false;
    let math = 0;
    let mono = 0;
    let total = 0;
    for (const run of allRuns) {
      const cx = run.x + run.width / 2;
      const cy = run.y + run.size * 0.3;
      if (cx < box.x0 || cx > box.x1 || cy < box.y0 || cy > box.y1) continue;
      const n = run.text.trim().length;
      total += n;
      // TeX roman math fonts (cmr7/10…) set digits and operators of formulas;
      // the CMU text fonts used for prose are not included.
      if (run.font === 'math' || (run.fontName && /^cm(r|bx)\d/i.test(run.fontName))) math += n;
      if (run.font === 'mono') mono += n;
    }
    return math >= 2 && mono < total * 0.3 && box.y1 - box.y0 < pageHeight * 0.4;
  });
  const boxed = new Set<Run>();
  if (mathBoxes.length) {
    const within = (r: { x0: number; y0: number; x1: number; y1: number }) =>
      mathBoxes.some(
        (box) =>
          (r.x0 + r.x1) / 2 >= box.x0 &&
          (r.x0 + r.x1) / 2 <= box.x1 &&
          (r.y0 + r.y1) / 2 >= box.y0 &&
          (r.y0 + r.y1) / 2 <= box.y1,
      );
    layout.tables = layout.tables.filter((table) => !within(table.rect));
    layout.figures = layout.figures.filter((figure) => !within(figure.rect));
    // A picture that wraps one or more result boxes (stacked boxes and the
    // sentence between them merged into one drawing) shows the same boxes a
    // second time, and swallows the sentence's words. The boxes are pictures
    // of their own, so the wrapper goes.
    const wraps = (outer: { x0: number; y0: number; x1: number; y1: number }) =>
      mathBoxes.some(
        (box) =>
          box.x0 >= outer.x0 - 3 &&
          box.x1 <= outer.x1 + 3 &&
          box.y0 >= outer.y0 - 3 &&
          box.y1 <= outer.y1 + 3 &&
          (outer.x1 - outer.x0) * (outer.y1 - outer.y0) >
            (box.x1 - box.x0) * (box.y1 - box.y0) * 1.05,
      );
    const wrappers = layout.figures.filter((figure) => wraps(figure.rect));
    layout.figures = layout.figures.filter((figure) => !wraps(figure.rect));
    // The wrapper had hidden every word inside it, including the end of the
    // sentence between the boxes ("… 写成 \\sqrt[n]{…}。"). With the wrapper
    // gone those words are body text again, unless they belong to a box,
    // a table or another picture that stays.
    const inRect = (r: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number) =>
      x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
    const have = new Set(runs);
    for (const run of allRuns) {
      if (have.has(run)) continue;
      const cx = run.x + run.width / 2;
      const cy = run.y + run.size * 0.3;
      if (!wrappers.some((w) => inRect(w.rect, cx, cy))) continue;
      if (mathBoxes.some((box) => inRect(box, cx, cy))) continue;
      if (layout.figures.some((f) => inRect(f.rect, cx, cy))) continue;
      if (layout.tables.some((t) => inRect(t.rect, cx, cy))) continue;
      runs.push(run);
    }
  }
  for (const box of mathBoxes) {
    for (const run of runs) {
      const cx = run.x + run.width / 2;
      const cy = run.y + run.size * 0.3;
      if (cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1) boxed.add(run);
    }
    result.pageWidth = pageWidth;
    result.pageHeight = pageHeight;
    entries.push({
      block: {
        kind: 'figure',
        text: '',
        figure: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
      },
      source: [],
      top: box.y1,
      order: nextOrder(),
    });
  }
  layout.tables.forEach((table, id) => {
    entries.push(...tableEntries(table, id, pageWidth, nextOrder));
  });
  if (layout.figures.length) {
    result.pageWidth = pageWidth;
    result.pageHeight = pageHeight;
  }
  for (const figure of layout.figures)
    entries.push({
      block: {
        kind: 'figure',
        text: '',
        figure: { ...figure.rect, ...(figure.equation ? { bodySize: layout.bodySize } : {}) },
      },
      source: [],
      top: figure.rect.y1,
      order: nextOrder(),
    });

  if (!runs.length && !entries.length) {
    warn('empty-text');
    return result;
  }

  // Stacked inline formulas (fractions, sums with limits) set in math fonts are
  // taken out of the text first and shown as small pictures in their sentence.
  const bodyEstimate = layout.bodySize || textSize(runs.filter((run) => !run.rotated)) || 10;
  const stacked = findInlineTextFormulas(
    buildLines(
      runs.filter((run) => !boxed.has(run)),
      pageWidth,
    ).lines,
    runs.filter((run) => !boxed.has(run)),
    bodyEstimate,
  );
  const stackedRuns = new Set(stacked.flatMap((item) => [...item.runs]));
  // Display formulas set in math fonts are kept whole as pictures.
  const formulas = textFormulaRegions(
    runs.filter((run) => !boxed.has(run) && !stackedRuns.has(run)),
    graphics?.segments ?? [],
    pageWidth,
    pageHeight,
    layout.bodySize || textSize(runs.filter((run) => !run.rotated)) || 10,
  );
  let flow =
    boxed.size || stackedRuns.size
      ? runs.filter((run) => !boxed.has(run) && !stackedRuns.has(run))
      : runs;
  if (formulas.length) {
    const used = new Set(formulas.flatMap((formula) => formula.runs));
    flow = flow.filter((run) => !used.has(run));
    result.pageWidth = pageWidth;
    result.pageHeight = pageHeight;
    for (const formula of formulas)
      entries.push({
        block: {
          kind: 'figure',
          text: '',
          figure: {
            x0: formula.x0,
            y0: formula.y0,
            x1: formula.x1,
            y1: formula.y1,
            bodySize: layout.bodySize || 10,
          },
        },
        source: [],
        top: formula.y1,
        order: nextOrder(),
      });
  }
  // Boxes, columns and margin notes are read as separate regions.
  const blockers = [
    ...layout.tables.map((t) => t.rect),
    ...layout.figures.map((f) => f.rect),
    ...formulas,
    ...mathBoxes,
  ];
  const regionInfo = assignRegions(flow, graphics, pageWidth, pageHeight, blockers);
  const { regions, regionOf } = regionInfo;
  let { lines } = buildLines(flow, pageWidth, regionOf);
  // Tables whose cells differ in size/baseline are found on row blocks first;
  // rule-less aligned tables are then found on the remaining baselines.
  const inCode = (line: Line) => {
    const mid = line.y + line.size * 0.3;
    return layout.codeBoxes.some(
      (box) => line.x >= box.x0 - 2 && line.end <= box.x1 + 2 && mid >= box.y0 && mid <= box.y1,
    );
  };
  const codeLines = new Set(lines.filter(inCode));
  // Lines set entirely in a typewriter font are code, whatever the shading.
  // A code line may end in a comment in another (CJK) font: the line starts
  // in the typewriter font and the comment follows a comment marker.
  const monoLine = (line: Line) => {
    let mono = 0;
    let other = 0;
    let comment = false;
    for (const run of line.runs) {
      const n = run.text.trim().length;
      if (run.font === 'mono') {
        mono += n;
        if (/(^|\s)(%|#|\/\/)\s*$/u.test(run.text) || /(^|\s)(%|#|\/\/)\s/u.test(run.text))
          comment = true;
      } else if (!comment && !/^[\s\p{P}\p{S}\d]*$/u.test(run.text)) other += n;
    }
    const first = line.runs[0];
    if (!(mono > 0) || first?.font !== 'mono') return false;
    // A lone token in a typewriter font inside prose ("[SEP] is a …") is an
    // inline identifier; code lines are either long or mostly typewriter.
    if (comment) return true;
    if (!(mono >= (mono + other) * 0.8 && (other === 0 || mono >= 12))) return false;
    // A single short identifier ending a sentence ("bruce.", "cat.") wrapped
    // onto its own line is prose, not a code listing.
    return !(line.runs.length <= 2 && /^[A-Za-z_]\w{0,15}\.$/u.test(line.text.trim()) && !inCode(line));
  };
  const codeText = new Set(lines.filter(monoLine));
  // Listings often set their CJK text (sample sentences, string contents) in
  // a non-typewriter font, so such a line fails the typewriter test and
  // splits one listing into several blocks. A line that has typewriter text,
  // starts at a code line's left edge and is spaced like the listing joins
  // it when code sits right above and below it, or when it opens with
  // typewriter text right under a code line.
  const monoShare = (line: Line) => {
    let mono = 0;
    let total = 0;
    for (const run of line.runs) {
      const n = run.text.trim().length;
      total += n;
      if (run.font === 'mono') mono += n;
    }
    return total ? mono / total : 0;
  };
  const listingNeighbour = (line: Line, above: boolean) =>
    [...codeText].some((code) => {
      const gap = above ? code.y - line.y : line.y - code.y;
      return (
        Math.abs(code.x - line.x) <= 2 &&
        Math.abs(code.size - line.size) <= 0.5 &&
        gap > 0 &&
        gap <= line.size * 1.75
      );
    });
  const listingLines = lines.filter((line) => {
    if (codeText.has(line)) return false;
    const share = monoShare(line);
    if (!(share > 0)) return false;
    const above = listingNeighbour(line, true);
    if (!above) return false;
    if (listingNeighbour(line, false)) return true;
    return line.runs[0]?.font === 'mono' && share >= 0.3;
  });
  for (const line of listingLines) codeText.add(line);
  for (const line of codeText) codeLines.add(line);
  const tableCandidates = lines.filter((line) => !codeLines.has(line));
  const sparse = detectSparseTables(tableCandidates, pageWidth);
  sparse.tables.forEach((table, i) => {
    entries.push(...tableEntries(table, layout.tables.length + i, pageWidth, nextOrder));
  });
  if (sparse.used.size) lines = lines.filter((line) => !sparse.used.has(line));
  const aligned = detectAlignedTables(
    lines.filter((line) => !codeLines.has(line)),
    pageWidth,
  );
  // A short aligned grid made of digits, symbols and units around an equals
  // sign is a stacked fraction equation, not a data table (NIST SI definition
  // of the second is one example).
  const numericFormula = (table: TableModel) => {
    if (table.rows < 2 || table.rows > 4 || table.cols > 3) return false;
    const text = table.cells
      .flatMap((cell) => cell.runs)
      .map((run) => run.text)
      .join(' ');
    const chars = text.replace(/\s/gu, '');
    const numeric = (chars.match(/[0-9∆Δν=+\-−/]/gu) ?? []).length;
    const words = (text.match(/[A-Za-z]{4,}/gu) ?? []).join('').length;
    return /[=]/u.test(text) && numeric >= 10 && words < 10 && numeric > chars.length * 0.3;
  };
  const alignedTables = aligned.tables.filter((table) => !numericFormula(table));
  const mathTables = aligned.tables.filter(numericFormula);
  for (const table of mathTables) {
    const pad = (layout.bodySize || 10) * 0.25;
    const rect = {
      x0: Math.max(0, table.rect.x0 - pad),
      y0: Math.max(0, table.rect.y0 - pad),
      x1: Math.min(pageWidth, table.rect.x1 + pad),
      y1: Math.min(pageHeight, table.rect.y1 + pad),
      bodySize: layout.bodySize || 10,
    };
    result.pageWidth = pageWidth;
    result.pageHeight = pageHeight;
    entries.push({
      block: { kind: 'figure', text: '', figure: rect },
      source: [],
      top: rect.y1,
      order: nextOrder(),
    });
  }
  alignedTables.forEach((table, i) => {
    entries.push(
      ...tableEntries(table, layout.tables.length + sparse.tables.length + i, pageWidth, nextOrder),
    );
  });
  for (const line of aligned.code) codeLines.add(line);
  if (aligned.used.size) lines = lines.filter((line) => !aligned.used.has(line));
  // Rows still spanning a wide gap that no region explains (boxes, columns and
  // margin notes are already separate) suggest an unrecognised layout.
  const inFigure = (line: Line) =>
    layout.figures.some(
      (figure) =>
        line.y >= figure.rect.y0 - line.size &&
        line.y <= figure.rect.y1 + line.size &&
        line.x >= figure.rect.x0 - line.size * 2 &&
        line.end <= figure.rect.x1 + line.size * 2,
    );
  // Running heads and feet (page number far from the title) are not columns.
  const margin = (line: Line) =>
    pageHeight > 0 && (line.y > pageHeight * 0.9 || line.y < pageHeight * 0.08);
  const wideGapRows = lines.filter(
    (line) => line.wideGap && !codeLines.has(line) && !inFigure(line) && !margin(line),
  ).length;
  const columns = wideGapRows >= 3 && !regionInfo.twoColumns;
  if (columns) warn('possible-multiple-columns');

  // A running head or foot is one small line in the page margin with the page
  // number split far from the title ("22 ........ 第三章 文档元素",
  // "§3.5 特殊环境 ........ 23") and clear space below (above, for a foot).
  // It repeats on every page and is not part of the text.
  const flowSize = textSize(lines.flatMap((line) => line.runs));
  const isRunningHead = (line: Line) => {
    if (!(pageHeight > 0) || line.runs.length < 2 || line.runs.some((run) => run.rotated))
      return false;
    const top = line.y > pageHeight * 0.9;
    if (!top && !(line.y < pageHeight * 0.08)) return false;
    // Not larger than the text by much (a page of 9pt listings under a 10pt
    // head still counts); real headings are far bigger than the body.
    if (line.size > flowSize * 1.3) return false;
    const runs = [...line.runs].sort((a, b) => a.x - b.x);
    const first = runs[0]!;
    const last = runs[runs.length - 1]!;
    const pageNumber = (run: Run) => /^\d{1,3}$/.test(run.text.trim());
    const farFromTitle = (number: Run, other: Run) =>
      Math.abs(other.x - number.x) - (other.x > number.x ? number.width : other.width) >=
      line.size * 3;
    const split =
      (pageNumber(first) && farFromTitle(first, runs[1]!)) ||
      (pageNumber(last) && farFromTitle(last, runs[runs.length - 2]!));
    if (!split) return false;
    // Body text must keep clear space from it: nothing else within 2.5 lines
    // towards the page's inside.
    return !lines.some(
      (other) =>
        other !== line &&
        (top
          ? other.y <= line.y + line.size * 0.5 && other.y >= line.y - line.size * 2.5
          : other.y >= line.y - line.size * 0.5 && other.y <= line.y + line.size * 2.5),
    );
  };
  const kept = lines.filter((line, index) => {
    if (isRunningHead(line)) {
      result.removedPageNumbers.push(line.text);
      return false;
    }
    if (!(pageHeight > 0) || !/^\d+$/.test(line.text)) return true;
    // Four-digit years are deliberately preserved, including in page margins.
    const number = Number(line.text);
    if (number >= 1000 && number <= 2999) return true;
    if (line.y > pageHeight * 0.075 && line.y < pageHeight * 0.925) return true;
    const neighbors = [lines[index - 1], lines[index + 1]].filter((v): v is Line => !!v);
    const isolated = neighbors.every(
      (other) => Math.abs(other.y - line.y) > Math.max(line.size, other.size) * 1.5,
    );
    if (!isolated || line.runs.some((run) => run.rotated)) return true;
    result.removedPageNumbers.push(line.text);
    return false;
  });
  const separators = [
    ...layout.tables.map((t) => t.rect),
    ...aligned.tables.map((t) => t.rect),
    ...sparse.tables.map((t) => t.rect),
    ...layout.figures.map((f) => f.rect),
  ];
  if (kept.length) {
    const bodySize = textSize(kept.flatMap((line) => line.runs));
    const bodyLines = kept.filter(
      (line) => line.size >= bodySize * 0.85 && line.size <= bodySize * 1.15,
    );
    const gaps = bodyLines
      .slice(1)
      .map((line, i) => bodyLines[i]!.y - line.y)
      .filter((gap) => gap > bodySize * 0.6 && gap < bodySize * 2.1);
    const leading = median(gaps) || bodySize * 1.3;
    const leftMargin = Math.min(...kept.map((line) => line.x));
    const bullets = vectorBullets(kept, graphics, bodySize);
    const dotLines = bullets.lines;
    const inlineByLine = findInlineEquations(
      (graphics?.shapes ?? []).filter((shape) => !bullets.shapes.has(shape)),
      kept,
      bodySize,
      [...separators, ...layout.codeBoxes],
      codeLines,
    );
    for (const item of stacked) {
      const { equation } = item;
      const target = kept.find(
        (line) =>
          Math.abs(line.y - item.line.y) <= line.size * 0.35 &&
          line.x <= equation.x1 + line.size * 2 &&
          line.end >= equation.x0 - line.size * 2,
      );
      if (!target) continue;
      const list = inlineByLine.get(target) ?? [];
      list.push(equation);
      list.sort((a, b) => a.x0 - b.x0);
      inlineByLine.set(target, list);
    }
    // A bullet in front of a line that opens with an equation: the dot sits
    // left of the equation, not left of the first word.
    const edges = new Map<Line, number>();
    for (const [line, equations] of inlineByLine) edges.set(line, equations[0]!.x0);
    const lateBullets = vectorBullets(kept, graphics, bodySize, edges);
    for (const line of lateBullets.lines) dotLines.add(line);
    const marked = new Map<Line, { text: string; source: number[]; inline: InlineEquation[] }>();
    for (const [line, equations] of inlineByLine) {
      const joined = joinLineWithEquations(line, equations);
      if (joined) marked.set(line, { ...joined, inline: equations });
    }
    const regionOfLine = (line: Line): Region =>
      regions[regionOf.get(line.runs[0]!) ?? 0] ?? regions[0]!;
    // Code blocks keep line breaks and indentation relative to the block's
    // leftmost line, measured in characters of the code font.
    const codeIndent = (line: Line, left: number) => {
      const glyph = median(
        line.runs
          .filter((run) => run.font === 'mono' && run.text.trim().length > 0)
          .map((run) => run.width / Math.max(1, run.text.length)),
      );
      const width = glyph > 0 ? glyph : line.size * 0.5;
      return ' '.repeat(Math.max(0, Math.min(40, Math.round((line.x - left) / width))));
    };
    const codeLeft = new Map<Region, number>();
    for (const line of kept)
      if (codeText.has(line)) {
        const region = regionOfLine(line);
        codeLeft.set(region, Math.min(codeLeft.get(region) ?? Infinity, line.x));
      }
    // Lines are read region by region: each region's lines top to bottom.
    const byRegion = new Map<Region, Line[]>();
    for (const line of kept) {
      const region = regionOfLine(line);
      const list = byRegion.get(region) ?? [];
      list.push(line);
      byRegion.set(region, list);
    }
    let previous: Line | undefined;
    let current: Entry | undefined;
    let previousRegion: Region | undefined;
    const ordered = [...byRegion.values()].flat();
    for (const line of ordered) {
      const region = regionOfLine(line);
      if (region !== previousRegion) {
        previous = undefined;
        current = undefined;
        previousRegion = region;
      }
      const code = codeText.has(line);
      const kind: ReflowBlock['kind'] = code
        ? 'code'
        : line.size < bodySize * 0.85
          ? 'note'
          : 'paragraph';
      if (code && current?.block.kind === 'code' && previous && codeText.has(previous)) {
        const gapCode = previous.y - line.y;
        if (gapCode <= Math.max(leading, line.size) * 2.2) {
          const indent = codeIndent(line, codeLeft.get(region) ?? line.x);
          // Blank lines between code lines are kept as one empty line.
          const blank = gapCode > Math.max(leading, line.size * 1.2) * 1.6 ? '\n' : '';
          const prefix = `\n${blank}${indent}`;
          current.block.text += prefix + line.text;
          current.source.push(...prefix.split('').map(() => -1), ...line.source);
          previous = line;
          continue;
        }
      }
      if (code) {
        const indent = codeIndent(line, codeLeft.get(region) ?? line.x);
        current = {
          block: { kind: 'code', text: indent + line.text },
          source: [...indent.split('').map(() => -1), ...line.source],
          top: line.y,
          order: nextOrder(),
          ...(region.groupTop !== undefined
            ? { groupTop: region.groupTop, groupX: region.groupX }
            : {}),
        };
        entries.push(current);
        previous = line;
        continue;
      }
      const gap = previous ? previous.y - line.y : Infinity;
      const sizeChange =
        previous && Math.max(previous.size, line.size) / Math.min(previous.size, line.size) > 1.18;
      const indented =
        previous &&
        line.x - leftMargin > line.size * 1.2 &&
        previous.x - leftMargin <= line.size * 0.7;
      const rotated =
        line.runs.some((run) => run.rotated) || previous?.runs.some((run) => run.rotated);
      // A table or figure sitting between two lines always splits the block.
      const separated =
        !!previous &&
        separators.some((rect) => {
          const mid = (rect.y0 + rect.y1) / 2;
          return mid < previous!.y && mid > line.y;
        });
      const limit = kind === 'note' ? line.size * 1.8 : Math.max(leading * 1.45, bodySize * 1.65);
      if (
        !current ||
        current.block.kind !== kind ||
        gap > limit ||
        sizeChange ||
        indented ||
        columns ||
        (codeLines.has(line) && !codeText.has(line)) ||
        (!!previous && codeLines.has(previous)) ||
        startsListItem(
          line.text,
          previous?.text,
          !!previous && previous.x - line.x >= line.size * 0.5,
        ) ||
        centredApart(line, previous) ||
        dotLines.has(line) ||
        rotated ||
        separated
      ) {
        const own = marked.get(line);
        current = {
          block: {
            kind,
            text: own?.text ?? line.text,
            ...(own ? { inline: [...own.inline] } : {}),
          },
          source: own?.source ?? line.source,
          top: line.y,
          order: nextOrder(),
          ...(region.groupTop !== undefined
            ? { groupTop: region.groupTop, groupX: region.groupX }
            : {}),
        };
        entries.push(current);
      } else {
        const own = marked.get(line);
        const joined = joinMapped(
          { text: current.block.text, source: current.source },
          own ?? line,
          true,
          true,
        );
        current.block.text = joined.text;
        current.source = joined.source;
        if (own) current.block.inline = [...(current.block.inline ?? []), ...own.inline];
      }
      previous = line;
    }
  }
  if (!entries.length) return result;

  // Reading order: top to bottom. Entries of a region group (a column pair,
  // side-by-side boxes) sort together at the group's top, left region first,
  // each keeping its own internal order. Tables, figures and formulas inside a
  // column join that column.
  for (const entry of entries) {
    if (entry.groupTop !== undefined || entry.block.kind === 'paragraph') continue;
    if (entry.block.kind === 'note' || entry.block.kind === 'code') continue;
    const rect = entry.block.figure ?? entry.rect;
    const x = rect ? (rect.x0 + rect.x1) / 2 : undefined;
    const y = rect ? (rect.y0 + rect.y1) / 2 : entry.top;
    if (x === undefined) continue;
    const region = regionAt(regions, x, y);
    if (region.kind === 'column' && rect && rect.x1 - rect.x0 < pageWidth * 0.55) {
      entry.groupTop = region.groupTop;
      entry.groupX = region.groupX;
    }
  }
  const key = (entry: Entry) => entry.groupTop ?? entry.top;
  entries.sort(
    (a, b) =>
      key(b) - key(a) || (a.groupX ?? -1) - (b.groupX ?? -1) || b.top - a.top || a.order - b.order,
  );
  for (const entry of entries) {
    result.blocks.push(entry.block);
    blockSources.push(entry.source);
  }
  return result;
}
