import type { PdfGraphics } from './pdfReflowGraphics';
import {
  analyzeLayout,
  detectAlignedTables,
  detectSparseTables,
  type TableModel,
} from './pdfReflowLayout';
import {
  buildLines,
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
}

export interface ReflowBlock {
  /** `cell` blocks are table cells: one block per cell so every index-based
   * service (speech highlight, selection, citation) keeps working unchanged.
   * `figure` blocks have no text; the page region is rendered as a picture. */
  kind: 'paragraph' | 'note' | 'cell' | 'figure';
  text: string;
  table?: ReflowTableCell;
  figure?: ReflowFigure;
}

export interface ReflowPage {
  blocks: ReflowBlock[];
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
const NUMBER_MARK = /^(?:\d{1,2}[.)]\s|[（(]\d{1,2}[）)]\s*|\d{1,2}[、．]\s*)\S/u;
const SENTENCE_END = /[.。;；:：!?！？)）]$/u;

/**
 * A new list item starts a new block. Bullets always do; numbered markers only
 * after a finished sentence or another item, so a wrapped line that happens to
 * begin with "2020) " or "3. " inside a sentence is not split.
 */
export function startsListItem(line: string, previous: string | undefined): boolean {
  const text = line.trimStart();
  if (BULLET_MARK.test(text)) return true;
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
function vectorBulletLines(lines: Line[], graphics: PdfGraphics | undefined, bodySize: number) {
  const found = new Set<Line>();
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
    const hit = dots.some((dot) => {
      const gap = line.x - dot.x1;
      const mid = (dot.y0 + dot.y1) / 2;
      return (
        gap >= -1 &&
        gap <= line.size * 2.5 &&
        mid >= line.y - line.size * 0.15 &&
        mid <= line.y + line.size * 0.95
      );
    });
    if (hit) found.add(line);
  }
  return found;
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
    allRuns.push({
      text,
      source,
      x: x!,
      y: y!,
      size,
      width: Math.abs(item.width),
      rotated,
      diagonal,
    });
  }
  dropDiagonalWatermark(allRuns, warn);

  const layout = analyzeLayout(allRuns, graphics, pageWidth, pageHeight);
  const runs = layout.flowRuns;
  const entries: Entry[] = [];
  let order = 0;
  const nextOrder = () => order++;
  layout.tables.forEach((table, id) => {
    entries.push(...tableEntries(table, id, pageWidth, nextOrder));
  });
  if (layout.figures.length) {
    result.pageWidth = pageWidth;
    result.pageHeight = pageHeight;
  }
  for (const figure of layout.figures)
    entries.push({
      block: { kind: 'figure', text: '', figure: { ...figure.rect } },
      source: [],
      top: figure.rect.y1,
      order: nextOrder(),
    });

  if (!runs.length && !entries.length) {
    warn('empty-text');
    return result;
  }

  let { lines } = buildLines(runs, pageWidth);
  // Tables whose cells differ in size/baseline are found on row blocks first;
  // rule-less aligned tables are then found on the remaining baselines.
  const inCode = (line: Line) => {
    const mid = line.y + line.size * 0.3;
    return layout.codeBoxes.some(
      (box) => line.x >= box.x0 - 2 && line.end <= box.x1 + 2 && mid >= box.y0 && mid <= box.y1,
    );
  };
  const codeLines = new Set(lines.filter(inCode));
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
  aligned.tables.forEach((table, i) => {
    entries.push(
      ...tableEntries(table, layout.tables.length + sparse.tables.length + i, pageWidth, nextOrder),
    );
  });
  for (const line of aligned.code) codeLines.add(line);
  if (aligned.used.size) lines = lines.filter((line) => !aligned.used.has(line));
  const wideGapRows = lines.filter((line) => line.wideGap).length;
  const columns = wideGapRows >= 2;
  if (columns) warn('possible-multiple-columns');

  const kept = lines.filter((line, index) => {
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
    const dotLines = vectorBulletLines(kept, graphics, bodySize);
    let previous: Line | undefined;
    let current: Entry | undefined;
    for (const line of kept) {
      const kind: ReflowBlock['kind'] = line.size < bodySize * 0.85 ? 'note' : 'paragraph';
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
        codeLines.has(line) ||
        (!!previous && codeLines.has(previous)) ||
        startsListItem(line.text, previous?.text) ||
        dotLines.has(line) ||
        rotated ||
        separated
      ) {
        current = {
          block: { kind, text: line.text },
          source: line.source,
          top: line.y,
          order: nextOrder(),
        };
        entries.push(current);
      } else {
        const joined = joinMapped(
          { text: current.block.text, source: current.source },
          line,
          true,
          true,
        );
        current.block.text = joined.text;
        current.source = joined.source;
      }
      previous = line;
    }
  }
  if (!entries.length) return result;

  // Reading order: top to bottom. Text already comes in visual row order, so
  // a stable sort only interleaves tables and figures at their vertical place.
  entries.sort((a, b) => b.top - a.top || a.order - b.order);
  for (const entry of entries) {
    result.blocks.push(entry.block);
    blockSources.push(entry.source);
  }
  return result;
}
