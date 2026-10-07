/**
 * Layout analysis for PDF reflow: recognises tables (ruled grids, rule-only
 * "booktabs" tables and rule-less aligned tables) and figures (bitmaps and
 * dense vector graphics). Pure geometry on already-extracted data, no DOM,
 * no rendering. Every detector is conservative: when evidence is weak the
 * content simply stays in the normal text flow.
 */
import type { PdfGraphics, Rect } from './pdfReflowGraphics';
import { buildLines, median, textSize, type Line, type Run } from './pdfReflowLines';

export interface TableCellModel {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  runs: Run[];
  header: boolean;
}

export interface TableModel {
  rect: Rect;
  rows: number;
  cols: number;
  headerRows: number;
  /** Row-major; positions covered by a span are omitted. */
  cells: TableCellModel[];
}

export interface FigureRegion {
  rect: Rect;
  /** True when the region contains vector drawing whose text labels belong to
   * the picture and must not also appear in the text flow. */
  suppressText: boolean;
  /** An equation drawn as glyph outlines (shown at reading-text scale). */
  equation?: boolean;
}

export interface LayoutResult {
  tables: TableModel[];
  figures: FigureRegion[];
  flowRuns: Run[];
  /** Large shaded boxes (code listings, call-outs): their lines never form tables. */
  codeBoxes: Rect[];
  /** Page body text size, PDF units. */
  bodySize: number;
  /** Segments/rects consumed by tables, for diagnostics and tests. */
  consumedSegments: number;
}

const TOL = 1.8;
const JOIN_TOL = 2.8;

const runCenter = (run: Run) => ({ x: run.x + run.width / 2, y: run.y + run.size * 0.3 });
const inRect = (rect: Rect, x: number, y: number, pad = 0) =>
  x >= rect.x0 - pad && x <= rect.x1 + pad && y >= rect.y0 - pad && y <= rect.y1 + pad;
const areaOf = (rect: Rect) => Math.max(0, rect.x1 - rect.x0) * Math.max(0, rect.y1 - rect.y0);
const touches = (a: Rect, b: Rect, pad = 0) =>
  a.x0 <= b.x1 + pad && b.x0 <= a.x1 + pad && a.y0 <= b.y1 + pad && b.y0 <= a.y1 + pad;
const unionRect = (a: Rect, b: Rect): Rect => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
});

/** A short horizontal stroke whose ends touch no other stroke: an arrow
 * shaft between a label and a value, not a piece of a cell border. */
function floatingStrokes(segments: PdfGraphics['segments'], rect: Rect): number {
  const inside = segments.filter(
    (seg) =>
      seg.x0 >= rect.x0 - 2 &&
      seg.x1 <= rect.x1 + 2 &&
      seg.y0 >= rect.y0 - 2 &&
      seg.y1 <= rect.y1 + 2,
  );
  const touchesOther = (seg: (typeof inside)[number], x: number, y: number) =>
    inside.some(
      (o) =>
        o !== seg &&
        x >= Math.min(o.x0, o.x1) - 1.5 &&
        x <= Math.max(o.x0, o.x1) + 1.5 &&
        y >= Math.min(o.y0, o.y1) - 1.5 &&
        y <= Math.max(o.y0, o.y1) + 1.5,
    );
  return inside.filter((seg) => {
    const len = Math.abs(seg.x1 - seg.x0);
    if (seg.y0 !== seg.y1 || len <= 4 || len >= (rect.x1 - rect.x0) * 0.2) return false;
    return !touchesOther(seg, seg.x0, seg.y0) && !touchesOther(seg, seg.x1, seg.y1);
  }).length;
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

interface Line1D {
  pos: number;
  a: number;
  b: number;
}

/** Merge collinear, overlapping or abutting segments into long rules. */
function mergeRules(values: Line1D[]): Line1D[] {
  const sorted = [...values].sort((p, q) => p.pos - q.pos);
  const clusters: Line1D[][] = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(value.pos - last[0]!.pos) <= TOL) last.push(value);
    else clusters.push([value]);
  }
  const result: Line1D[] = [];
  for (const cluster of clusters) {
    const pos = cluster.reduce((n, v) => n + v.pos, 0) / cluster.length;
    const byStart = [...cluster].sort((p, q) => p.a - q.a);
    let current = { pos, a: byStart[0]!.a, b: byStart[0]!.b };
    for (const value of byStart.slice(1)) {
      if (value.a <= current.b + JOIN_TOL) current.b = Math.max(current.b, value.b);
      else {
        result.push(current);
        current = { pos, a: value.a, b: value.b };
      }
    }
    result.push(current);
  }
  return result;
}

function clusterValues(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const value of sorted) {
    const last = groups[groups.length - 1];
    if (last && value - last[last.length - 1]! <= TOL + 0.7) last.push(value);
    else groups.push([value]);
  }
  return groups.map((g) => g.reduce((n, v) => n + v, 0) / g.length);
}

const coverage = (rules: Line1D[], pos: number, from: number, to: number): number => {
  const spans = rules
    .filter((r) => Math.abs(r.pos - pos) <= TOL + 0.7)
    .map((r) => [Math.max(from, r.a), Math.min(to, r.b)] as const)
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    const start = Math.max(a, end);
    if (b > start) covered += b - start;
    end = Math.max(end, b);
  }
  return to > from ? covered / (to - from) : 0;
};

const NUMERIC = /^[\s\d.,:%$¥€£+\-−–()/]+$/u;
const hasDigit = /\d/u;

/** Rows × columns of cell texts → does the first row look like a header? */
function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0]!.filter((t) => t.trim());
  if (first.length < 2) return false;
  if (first.some((t) => NUMERIC.test(t))) return false;
  return rows.slice(1).some((row) => row.some((t) => t.trim() && hasDigit.test(t)));
}

const runsText = (runs: Run[]) =>
  [...runs]
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((r) => r.text)
    .join(' ');

/* ----------------------------- ruled grids ------------------------------ */

function gridTable(
  hRules: Line1D[],
  vRules: Line1D[],
  runs: Run[],
): { model: TableModel | null; figureLike: boolean } {
  const xs = clusterValues(vRules.map((v) => v.pos));
  const ys = clusterValues(hRules.map((h) => h.pos)).sort((a, b) => b - a);
  if (xs.length < 2 || ys.length < 2) return { model: null, figureLike: false };
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  if (cols * rows > 400) return { model: null, figureLike: true };
  const rect: Rect = { x0: xs[0]!, x1: xs[cols]!, y0: ys[rows]!, y1: ys[0]! };

  const verticalPresent = (c: number, r: number) =>
    coverage(vRules, xs[c]!, ys[r + 1]!, ys[r]!) >= 0.6;
  const horizontalPresent = (r: number, c: number) =>
    coverage(hRules, ys[r]!, xs[c]!, xs[c + 1]!) >= 0.6;

  const visited: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const cells: Array<Omit<TableCellModel, 'runs' | 'header'>> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r]![c]) continue;
      let colSpan = 1;
      while (c + colSpan < cols && !verticalPresent(c + colSpan, r)) colSpan++;
      let rowSpan = 1;
      const canExtend = (nextRow: number) => {
        for (let cc = c; cc < c + colSpan; cc++) if (horizontalPresent(nextRow, cc)) return false;
        // Internal verticals of the added row must be absent too.
        for (let cc = c + 1; cc < c + colSpan; cc++) if (verticalPresent(cc, nextRow)) return false;
        return true;
      };
      while (r + rowSpan < rows && canExtend(r + rowSpan)) rowSpan++;
      let free = true;
      for (let rr = r; rr < r + rowSpan && free; rr++)
        for (let cc = c; cc < c + colSpan; cc++) if (visited[rr]![cc]) free = false;
      if (!free) {
        colSpan = 1;
        rowSpan = 1;
      }
      for (let rr = r; rr < r + rowSpan; rr++)
        for (let cc = c; cc < c + colSpan; cc++) visited[rr]![cc] = true;
      cells.push({ row: r, col: c, rowSpan, colSpan });
    }
  }

  const owner = new Map<string, number>();
  cells.forEach((cell, index) => {
    for (let rr = cell.row; rr < cell.row + cell.rowSpan; rr++)
      for (let cc = cell.col; cc < cell.col + cell.colSpan; cc++) owner.set(`${rr}:${cc}`, index);
  });
  const assigned: Run[][] = cells.map(() => []);
  const members: Run[] = [];
  for (const run of runs) {
    const { x, y } = runCenter(run);
    if (!inRect(rect, x, y, 2.5)) continue;
    let c = 0;
    while (c + 1 < cols && x >= xs[c + 1]! - TOL) c++;
    let r = 0;
    while (r + 1 < rows && y <= ys[r + 1]! + TOL) r++;
    const index = owner.get(`${r}:${c}`);
    if (index === undefined) continue;
    assigned[index]!.push(run);
    members.push(run);
  }
  const filled = assigned.filter((list) => list.length).length;
  if (filled < 2 || filled < cells.length * 0.4) return { model: null, figureLike: true };

  const textRows: string[][] = Array.from({ length: rows }, () => Array(cols).fill(''));
  cells.forEach((cell, index) => {
    textRows[cell.row]![cell.col] = runsText(assigned[index]!);
  });
  const headerRows = looksLikeHeader(textRows) ? 1 : 0;
  return {
    figureLike: false,
    model: {
      rect,
      rows,
      cols,
      headerRows,
      cells: cells.map((cell, index) => ({
        ...cell,
        runs: assigned[index]!,
        header: cell.row < headerRows,
      })),
    },
  };
}

interface GridResult {
  tables: TableModel[];
  consumedRuns: Set<Run>;
  leftoverHorizontals: Line1D[];
  rejectedBoxes: Rect[];
  consumed: number;
}

function detectGrids(hRaw: Line1D[], vRaw: Line1D[], runs: Run[]): GridResult {
  const result: GridResult = {
    tables: [],
    consumedRuns: new Set(),
    leftoverHorizontals: [],
    rejectedBoxes: [],
    consumed: 0,
  };
  const h = mergeRules(hRaw).filter((r) => r.b - r.a >= 8);
  const v = mergeRules(vRaw).filter((r) => r.b - r.a >= 8);
  if (h.length > 600 || v.length > 600) {
    result.leftoverHorizontals = h;
    return result;
  }
  const uf = new UnionFind(h.length + v.length);
  for (let i = 0; i < h.length; i++)
    for (let j = 0; j < v.length; j++) {
      const hr = h[i]!;
      const vr = v[j]!;
      if (
        vr.pos >= hr.a - JOIN_TOL &&
        vr.pos <= hr.b + JOIN_TOL &&
        hr.pos >= vr.a - JOIN_TOL &&
        hr.pos <= vr.b + JOIN_TOL
      )
        uf.union(i, h.length + j);
    }
  const groups = new Map<number, { h: Line1D[]; v: Line1D[] }>();
  h.forEach((rule, i) => {
    const key = uf.find(i);
    (groups.get(key) ?? groups.set(key, { h: [], v: [] }).get(key)!).h.push(rule);
  });
  v.forEach((rule, j) => {
    const key = uf.find(h.length + j);
    (groups.get(key) ?? groups.set(key, { h: [], v: [] }).get(key)!).v.push(rule);
  });
  for (const group of groups.values()) {
    if (group.v.length < 2 || group.h.length < 2) {
      result.leftoverHorizontals.push(...group.h);
      continue;
    }
    const { model, figureLike } = gridTable(group.h, group.v, runs);
    if (model && model.rows >= 2 && model.cols >= 2) {
      result.tables.push(model);
      result.consumed += group.h.length + group.v.length;
      for (const cell of model.cells) for (const run of cell.runs) result.consumedRuns.add(run);
    } else {
      // A single framed box (call-out) or a sparse drawing grid: not a table.
      if (figureLike) {
        const xs = group.v.map((r) => r.pos);
        const ys = group.h.map((r) => r.pos);
        const box = {
          x0: Math.min(...xs),
          x1: Math.max(...xs),
          y0: Math.min(...ys),
          y1: Math.max(...ys),
        };
        // A frame around a code listing is a text box, never a picture.
        let mono = 0;
        let total = 0;
        for (const run of runs) {
          const c = runCenter(run);
          if (!inRect(box, c.x, c.y)) continue;
          const n = run.text.trim().length;
          total += n;
          if (run.font === 'mono') mono += n;
        }
        if (!(total > 0 && mono >= total * 0.6)) result.rejectedBoxes.push(box);
      }
      result.leftoverHorizontals.push(...group.h);
    }
  }
  return result;
}

/* ------------------------- aligned (text) columns ------------------------ */

interface Segment {
  x0: number;
  x1: number;
  runs: Run[];
  text: string;
}

function segmentLine(line: Line, gap: number): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | undefined;
  let end = -Infinity;
  const NUMBER = /^[\s\d.,%+\-−–—()]+$/u;
  for (const run of line.runs) {
    // Blank runs are padding: they neither start a segment nor extend one.
    if (!run.text.trim()) continue;
    // Numeric columns sit closer than word columns ("86.6 86.3", "- 78.0"):
    // two numeric pieces separated by more than a narrow space are two cells.
    const numeric =
      !!current &&
      NUMBER.test(run.text) &&
      NUMBER.test(current.runs[current.runs.length - 1]!.text);
    if (!current || run.x - end > gap || (numeric && run.x - end > gap * 0.4)) {
      current = { x0: run.x, x1: run.x + run.width, runs: [], text: '' };
      segments.push(current);
    }
    current.runs.push(run);
    current.x1 = Math.max(current.x1, run.x + run.width);
    end = Math.max(end, run.x + run.width);
  }
  for (const segment of segments) segment.text = runsText(segment.runs).trim();
  return segments;
}

interface ColumnFit {
  bands: Array<[number, number]>;
  rows: Array<Array<{ col: number; colSpan: number; segment: Segment }>>;
}

/** Column bands come from the rows that carry the modal number of segments.
 * Spanning headers and sparse rows are then placed against those bands. */
function inferColumns(rows: Segment[][], minShare: number): ColumnFit | null {
  const counts = new Map<number, number>();
  for (const row of rows)
    if (row.length >= 2) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let modal = 0;
  let best = 0;
  for (const [count, times] of counts)
    if (times > best || (times === best && count > modal)) {
      modal = count;
      best = times;
    }
  if (modal < 2 || best < Math.max(2, Math.ceil(rows.length * minShare))) return null;
  // Wrapped continuation rows carry fewer segments than full rows and can
  // outnumber them; prefer the widest layout that still repeats.
  for (const [count, times] of counts)
    if (count > modal && times >= 2 && times >= best * 0.5) modal = count;
  const body = rows.filter((row) => row.length === modal);
  const bands: Array<[number, number]> = [];
  for (let j = 0; j < modal; j++)
    bands.push([Math.min(...body.map((r) => r[j]!.x0)), Math.max(...body.map((r) => r[j]!.x1))]);
  for (let j = 0; j + 1 < modal; j++) if (bands[j]![1] >= bands[j + 1]![0]) return null;
  const placed = rows.map((row) =>
    row.map((segment) => {
      const hit: number[] = [];
      bands.forEach((band, j) => {
        if (Math.min(band[1], segment.x1) - Math.max(band[0], segment.x0) > 0) hit.push(j);
      });
      if (!hit.length) {
        const mid = (segment.x0 + segment.x1) / 2;
        let nearest = 0;
        bands.forEach((band, j) => {
          const d = Math.abs((band[0] + band[1]) / 2 - mid);
          if (d < Math.abs((bands[nearest]![0] + bands[nearest]![1]) / 2 - mid)) nearest = j;
        });
        hit.push(nearest);
      }
      return { col: hit[0]!, colSpan: hit[hit.length - 1]! - hit[0]! + 1, segment };
    }),
  );
  return { bands, rows: placed };
}

function modelFromRows(
  fit: ColumnFit,
  rect: Rect,
  headerRowCount: number,
  mergeContinuations: boolean,
  lines: Line[],
  leading: number,
): TableModel | null {
  type Placed = ColumnFit['rows'][number];
  const rows: Array<{ cells: Placed; y: number }> = [];
  fit.rows.forEach((cells, index) => {
    const line = lines[index]!;
    const previous = rows[rows.length - 1];
    const firstEmpty = !cells.some((cell) => cell.col === 0);
    // A sub-header row ("EM F1 EM F1" under spanning "Dev" / "Test") has
    // as many cells as there are columns under the spans: it is a row of its
    // own, not the wrapped continuation of the row above.
    const filledAbove = new Set(
      (previous?.cells ?? []).flatMap((cell) =>
        Array.from({ length: cell.colSpan }, (_, k) => cell.col + k),
      ),
    );
    const subHeader =
      cells.length >= 2 && cells.filter((cell) => filledAbove.has(cell.col)).length >= 2;
    if (
      mergeContinuations &&
      previous &&
      firstEmpty &&
      !subHeader &&
      previous.cells.some((cell) => cell.col === 0) &&
      previous.y - line.y <= leading * 1.3
    ) {
      previous.cells = [...previous.cells, ...cells];
      previous.y = line.y;
      return;
    }
    rows.push({ cells, y: line.y });
  });
  const cols = fit.bands.length;
  if (rows.length < 2 || cols < 2) return null;
  const cells: TableCellModel[] = [];
  rows.forEach((row, r) => {
    const byCol = new Map<number, Placed>();
    for (const cell of row.cells)
      (byCol.get(cell.col) ?? byCol.set(cell.col, []).get(cell.col)!).push(cell);
    let c = 0;
    while (c < cols) {
      const group = byCol.get(c);
      if (!group) {
        cells.push({
          row: r,
          col: c,
          rowSpan: 1,
          colSpan: 1,
          runs: [],
          header: r < headerRowCount,
        });
        c++;
        continue;
      }
      const span = Math.max(...group.map((cell) => cell.colSpan));
      cells.push({
        row: r,
        col: c,
        rowSpan: 1,
        colSpan: Math.min(span, cols - c),
        runs: group.flatMap((cell) => cell.segment.runs),
        header: r < headerRowCount,
      });
      c += Math.min(span, cols - c);
    }
  });
  return { rect, rows: rows.length, cols, headerRows: headerRowCount, cells };
}

const segmentRect = (rows: Segment[][], lines: Line[]): Rect => ({
  x0: Math.min(...rows.flat().map((s) => s.x0)),
  x1: Math.max(...rows.flat().map((s) => s.x1)),
  y0: Math.min(...lines.map((l) => l.y - l.size * 0.25)),
  y1: Math.max(...lines.map((l) => l.y + l.size * 0.9)),
});

/**
 * A table whose rows are separated by rules (one rule per row, multi-line
 * cells, a group-label column whose rules stop short). Rows are the bands
 * between consecutive rules; columns are the left edges shared by the
 * segments of most bands. Cell text joins every line of the band in reading
 * order. Bands without text in the first column continue a spanning label.
 */
function bandTable(
  group: Line1D[],
  inside: Run[],
  pageWidth: number,
  rect: Rect,
): TableModel | null {
  const positions = [...new Set(group.map((r) => Math.round(r.pos * 2) / 2))].sort((a, b) => b - a);
  if (positions.length < 5) return null;
  const bands: Array<{ y0: number; y1: number; runs: Run[] }> = [];
  for (let i = 0; i + 1 < positions.length; i++) {
    const y1 = positions[i]!;
    const y0 = positions[i + 1]!;
    const runs = inside.filter((run) => {
      const { y } = runCenter(run);
      return y < y1 && y > y0;
    });
    if (runs.length) bands.push({ y0, y1, runs });
  }
  if (bands.length < 3) return null;
  // Columns are separated by vertical gutters: x ranges that (almost) no
  // segment of any band covers. Centred columns have scattered left edges, so
  // the gutters, not the starts, define them.
  const size = median(inside.map((r) => r.size)) || 10;
  const segments = bands.flatMap((band) => {
    const { lines } = buildLines(band.runs, pageWidth);
    return lines.flatMap((line) => segmentLine(line, size * 1.0));
  });
  const x0 = Math.min(...segments.map((seg) => seg.x0));
  const x1 = Math.max(...segments.map((seg) => seg.x1));
  const step = 1;
  const covered: number[] = [];
  for (let x = x0; x <= x1; x += step)
    covered.push(segments.filter((seg) => seg.x0 <= x && seg.x1 >= x).length);
  const allowed = Math.max(1, Math.floor(segments.length * 0.02));
  const gutters: Array<[number, number]> = [];
  let start = -1;
  covered.forEach((n, i) => {
    if (n <= allowed) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if ((i - start) * step >= size * 0.6) gutters.push([x0 + start * step, x0 + i * step]);
      start = -1;
    }
  });
  // Column boundaries: the middle of each gutter. Cells start right after it.
  const columns = [x0, ...gutters.map(([a, b]) => (a + b) / 2)];
  if (columns.length < 2 || columns.length > 8) return null;
  const colOf = (x: number) => {
    let c = 0;
    for (let k = 0; k < columns.length; k++) if (x >= columns[k]! - 1) c = k;
    return c;
  };
  // A text item that runs across a column boundary (two cells written as one
  // string) is cut there, assuming evenly wide characters, so each part lands
  // in its own cell. Source offsets stay with their characters.
  const splitRun = (run: Run): Run[] => {
    const parts: Run[] = [];
    let rest = run;
    for (const edge of columns.slice(1)) {
      // Only a real crossing (at least about one character on each side) is
      // cut; a run that just starts a hair before the edge belongs right.
      if (!(rest.x < edge - rest.size * 0.6 && rest.x + rest.width > edge + rest.size * 0.6))
        continue;
      // CJK characters are about one em wide, Latin and punctuation about half.
      const chars = Array.from(rest.text);
      const weight = chars.map((ch) => (/[\u2e80-\u9fff\uff00-\uffef]/u.test(ch) ? 1 : 0.5));
      const total = weight.reduce((a, b) => a + b, 0) || 1;
      const unit = rest.width / total;
      let cut = 0;
      let used = 0;
      while (cut < chars.length && rest.x + (used + weight[cut]! / 2) * unit < edge) {
        used += weight[cut]!;
        cut += 1;
      }
      if (cut <= 0 || cut >= chars.length) continue;
      const head = chars.slice(0, cut).join('');
      const tail = chars.slice(cut).join('');
      parts.push({
        ...rest,
        text: head,
        width: unit * used,
        source: rest.source.slice(0, head.length),
      });
      rest = {
        ...rest,
        text: tail,
        x: rest.x + unit * used,
        width: rest.width - unit * used,
        source: rest.source.slice(head.length),
      };
    }
    parts.push(rest);
    return parts;
  };
  const cells: TableCellModel[] = [];
  bands.forEach((band, r) => {
    const byCol: Run[][] = columns.map(() => []);
    for (const run of band.runs.flatMap(splitRun))
      byCol[colOf(run.x + Math.min(run.width / 2, run.size))]!.push(run);
    byCol.forEach((runs, c) =>
      cells.push({ row: r, col: c, rowSpan: 1, colSpan: 1, runs, header: r === 0 }),
    );
  });
  // A label alone in the first column of a band, followed by bands whose
  // first column is empty, spans them when it sits within those bands.
  const first = (r: number) => cells.find((c) => c.row === r && c.col === 0);
  for (let r = 1; r < bands.length; r++) {
    const cell = first(r);
    if (!cell || !cell.runs.length) continue;
    let end = r;
    while (end + 1 < bands.length && first(end + 1) && !first(end + 1)!.runs.length) end++;
    let begin = r;
    while (begin - 1 >= 1 && first(begin - 1) && !first(begin - 1)!.runs.length) begin--;
    if (end === r && begin === r) continue;
    // The label's own band must be between begin and end, and the label's
    // centre should be near the middle of the spanned range.
    const ys = cell.runs.map((run) => run.y);
    const mid = (Math.max(...ys) + Math.min(...ys)) / 2;
    const top = bands[begin]!.y1;
    const bottom = bands[end]!.y0;
    if (!(mid < top && mid > bottom)) continue;
    for (let k = begin; k <= end; k++) {
      if (k === r) continue;
      const index = cells.findIndex((c) => c.row === k && c.col === 0);
      if (index >= 0) cells.splice(index, 1);
    }
    cell.row = begin;
    cell.rowSpan = end - begin + 1;
    r = end;
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  return { rect, rows: bands.length, cols: columns.length, headerRows: 1, cells };
}

/* ---------------------------- rule-only tables --------------------------- */

function detectRuleTables(
  rules: Line1D[],
  runs: Run[],
  pageWidth: number,
  pageHeight: number,
): { tables: TableModel[]; consumedRuns: Set<Run>; usedRules: Set<Line1D> } {
  const out = {
    tables: [] as TableModel[],
    consumedRuns: new Set<Run>(),
    usedRules: new Set<Line1D>(),
  };
  const minLength = Math.max(60, pageWidth * 0.2);
  const long = rules.filter((r) => r.b - r.a >= minLength).sort((p, q) => q.pos - p.pos);
  const sameExtent = (p: Line1D, q: Line1D) => {
    const tol = Math.max(4, pageWidth * 0.035);
    return Math.abs(p.a - q.a) <= tol && Math.abs(p.b - q.b) <= tol;
  };
  // Rules of one table share their horizontal extent. Tables side by side (two
  // columns) interleave in y, so rules are grouped per extent first, then
  // split where consecutive rules are too far apart or have no text between.
  const groups: Line1D[][] = [];
  const byExtent: Line1D[][] = [];
  for (const rule of long) {
    const bucket = byExtent.find((list) => sameExtent(list[0]!, rule));
    if (bucket) bucket.push(rule);
    else byExtent.push([rule]);
  }
  for (const list of byExtent) {
    let current: Line1D[] = [];
    for (const rule of list) {
      const first = current[0];
      const last = current[current.length - 1];
      // A caption ("Table 2: ...") between two rules ends one table.
      const caption =
        !!last &&
        runs.some(
          (run) =>
            run.y > rule.pos &&
            run.y < last.pos &&
            run.x + run.width / 2 >= rule.a - 3 &&
            run.x + run.width / 2 <= rule.b + 3 &&
            /^(Table|Figure|Fig\.|表|图)\s*\d/u.test(run.text.trim()),
        );
      if (
        first &&
        last &&
        !caption &&
        first.pos - rule.pos <= pageHeight * 0.6 &&
        last.pos - rule.pos <= pageHeight * 0.45 &&
        runs.some(
          (run) =>
            run.y > rule.pos &&
            run.y < last.pos &&
            run.x + run.width / 2 >= rule.a - 3 &&
            run.x + run.width / 2 <= rule.b + 3,
        )
      ) {
        current.push(rule);
      } else {
        if (current.length >= 2) groups.push(current);
        current = [rule];
      }
    }
    if (current.length >= 2) groups.push(current);
  }

  // Two groups with the same right edge, one enclosing the other in height,
  // whose left edges differ by a label column (group separators across the
  // label column, row rules across the rest) may be one banded table. The
  // merge is tentative: it is kept only when the bands form a table.
  for (let i = 0; i < groups.length; i++)
    for (let j = 0; j < groups.length; j++) {
      if (i === j) continue;
      const outer = groups[i]!;
      const inner = groups[j]!;
      if (outer.length < 3 || inner.length < 3) continue;
      const oTop = Math.max(...outer.map((r) => r.pos));
      const oBottom = Math.min(...outer.map((r) => r.pos));
      const iTop = Math.max(...inner.map((r) => r.pos));
      const iBottom = Math.min(...inner.map((r) => r.pos));
      const oLeft = Math.min(...outer.map((r) => r.a));
      const iLeft = Math.min(...inner.map((r) => r.a));
      const oRight = Math.max(...outer.map((r) => r.b));
      const iRight = Math.max(...inner.map((r) => r.b));
      if (Math.abs(oRight - iRight) > 4) continue;
      if (!(iLeft - oLeft > 8 && iLeft - oLeft <= pageWidth * 0.15)) continue;
      if (!(oTop >= iTop && oBottom <= iBottom)) continue;
      const merged = [...outer, ...inner].sort((p, q) => q.pos - p.pos);
      const inside = runs.filter((run) => {
        if (run.rotated) return false;
        const { x, y } = runCenter(run);
        return y < oTop + 1 && y > oBottom - 1 && x >= oLeft - 3 && x <= oRight + 3;
      });
      const mono = inside.filter((run) => run.font === 'mono').length;
      if (inside.length < 8 || mono > inside.length * 0.3) continue;
      const model = bandTable(merged, inside, pageWidth, {
        x0: oLeft,
        x1: oRight,
        y0: oBottom,
        y1: oTop,
      });
      if (!model) continue;
      out.tables.push(model);
      for (const run of inside) out.consumedRuns.add(run);
      for (const rule of merged) out.usedRules.add(rule);
      groups.splice(Math.max(i, j), 1);
      groups.splice(Math.min(i, j), 1);
      i = -1;
      break;
    }
  for (const group of groups) {
    const top = group[0]!;
    const bottom = group[group.length - 1]!;
    const x0 = Math.min(...group.map((r) => r.a));
    const x1 = Math.max(...group.map((r) => r.b));
    const inside = runs.filter((run) => {
      if (out.consumedRuns.has(run) || run.rotated) return false;
      const { x, y } = runCenter(run);
      return y < top.pos + 1 && y > bottom.pos - 1 && x >= x0 - 3 && x <= x1 + 3;
    });
    if (inside.length < 4) continue;
    const { lines } = buildLines(inside, pageWidth);
    if (lines.length < 2) continue;
    const size = median(lines.map((l) => l.size)) || 10;
    const segments = lines.map((line) => segmentLine(line, size * 1.0));
    // Rules already bound the table; group labels ("Published", "Ours") and
    // spanning headers take many rows, so a smaller modal share suffices.
    const fit = inferColumns(segments, group.length >= 3 ? 0.3 : 0.4);
    // Many rules: rows are the bands between rules (multi-line cells).
    if (
      group.length >= 6 &&
      inside.filter((run) => run.font === 'mono').length < inside.length * 0.3
    ) {
      const banded = bandTable(group, inside, pageWidth, { x0, x1, y0: bottom.pos, y1: top.pos });
      if (banded) {
        out.tables.push(banded);
        for (const run of inside) out.consumedRuns.add(run);
        for (const rule of group) out.usedRules.add(rule);
        continue;
      }
    }
    if (!fit) continue;
    const gaps = lines.slice(1).map((line, i) => lines[i]!.y - line.y);
    const leading = median(gaps) || size * 1.3;
    // Rows above the first inner rule form the header.
    const inner = group.slice(1, -1);
    const headerRows = inner.length
      ? lines.filter((line) => line.y > inner[0]!.pos).length
      : looksLikeHeader(segments.map((row) => row.map((s) => s.text)))
        ? 1
        : 0;
    const model = modelFromRows(
      fit,
      { x0, x1, y0: bottom.pos, y1: top.pos },
      headerRows,
      true,
      lines,
      leading,
    );
    if (!model) continue;
    out.tables.push(model);
    for (const run of inside) out.consumedRuns.add(run);
    for (const rule of group) out.usedRules.add(rule);
  }
  return out;
}

/* ------------------------- rule-less aligned tables ---------------------- */

/** Code with trailing comments ("x = 1   # why") lines up like a two-column
 * table. When most rows end in a comment, it is source code, not a table. */
const COMMENT_START = /^(?:#|\/\/|\/\*|<!--)/u;
function looksLikeCommentedCode(rows: Segment[][]): boolean {
  const commented = rows.filter((row) => {
    const last = row[row.length - 1];
    return row.length >= 2 && !!last && COMMENT_START.test(last.text);
  }).length;
  return commented >= 2 && commented >= rows.length * 0.6;
}

function detectAlignedTables(
  lines: Line[],
  pageWidth: number,
): { tables: TableModel[]; used: Set<Line>; code: Set<Line> } {
  const out = { tables: [] as TableModel[], used: new Set<Line>(), code: new Set<Line>() };
  const flat = lines.filter((line) => !line.runs.some((run) => run.rotated));
  if (flat.length < 3) return out;
  const size = median(flat.map((l) => l.size)) || 10;
  const gaps = flat
    .slice(1)
    .map((line, i) => flat[i]!.y - line.y)
    .filter((g) => g > size * 0.6 && g < size * 3);
  const leading = median(gaps) || size * 1.4;
  const segments = new Map<Line, Segment[]>();
  for (const line of flat) segments.set(line, segmentLine(line, Math.max(line.size * 1.1, 8)));

  let group: Line[] = [];
  const flush = () => {
    if (group.length >= 3) {
      const rows = group.map((line) => segments.get(line)!);
      if (looksLikeCommentedCode(rows)) {
        for (const line of group) out.code.add(line);
        group = [];
        return;
      }
      const fit = inferColumns(rows, 0.6);
      const cellTexts = rows.flat().map((s) => s.text);
      const shortish =
        cellTexts.filter((t) => t.length <= 18 || hasDigit.test(t)).length >=
        cellTexts.length * 0.5;
      const meanLength =
        cellTexts.reduce((n, t) => n + t.length, 0) / Math.max(1, cellTexts.length);
      if (fit && shortish && meanLength <= 26 && pageWidth > 0) {
        const header = looksLikeHeader(rows.map((row) => row.map((s) => s.text))) ? 1 : 0;
        const model = modelFromRows(fit, segmentRect(rows, group), header, false, group, leading);
        if (model) {
          out.tables.push(model);
          for (const line of group) out.used.add(line);
        }
      }
    }
    group = [];
  };
  for (let i = 0; i < flat.length; i++) {
    const line = flat[i]!;
    const count = segments.get(line)!.length;
    const previous = group[group.length - 1];
    const close = !previous || previous.y - line.y <= leading * 2.4;
    if (!close) flush();
    if (count >= 2) group.push(line);
    else {
      // A single-segment line may sit inside a table (spanning header or a
      // wrapped label) only when a multi-segment line follows right after.
      const next = flat[i + 1];
      if (
        group.length &&
        next &&
        segments.get(next)!.length >= 2 &&
        group[group.length - 1]!.y - line.y <= leading * 1.5
      )
        group.push(line);
      else flush();
    }
  }
  flush();
  return out;
}

/* ------------------- sparse tables with mixed-size cells ------------------ */

const SCRIPT_TEXT = /^[\d()*†‡+\-−]{1,3}$/u;

/** Footnote marks / superscripts printed beside a cell label sit on their own
 * baseline; pull them onto the host run's baseline so they stay in that cell. */
function attachScripts(runs: Run[]): Run[] {
  const isFragment = (run: Run) => SCRIPT_TEXT.test(run.text.trim());
  return runs.map((run) => {
    if (!isFragment(run)) return run;
    let host: Run | undefined;
    for (const other of runs) {
      if (other === run || isFragment(other) || !other.text.trim()) continue;
      const gap = run.x - (other.x + other.width);
      const dy = Math.abs(run.y - other.y);
      if (
        gap >= -1 &&
        gap <= other.size * 0.6 &&
        dy > 0.15 * other.size &&
        dy <= 0.7 * other.size &&
        run.size <= other.size * 1.05 &&
        (!host || gap < run.x - (host.x + host.width))
      )
        host = other;
    }
    return host ? { ...run, y: host.y } : run;
  });
}

/**
 * Rows whose cells have different font sizes and baselines (small labels
 * beside large, vertically centred figures) cannot be found on baselines.
 * Here a row is a vertical block: consecutive lines closer than ~1.6 line
 * heights belong together, a larger gap starts the next row. Columns are then
 * inferred from the horizontal runs of every row, exactly like aligned tables.
 */
function detectSparseTables(
  lines: Line[],
  pageWidth: number,
): { tables: TableModel[]; used: Set<Line> } {
  const out = { tables: [] as TableModel[], used: new Set<Line>() };
  const flat = lines.filter((line) => !line.runs.some((run) => run.rotated));
  if (flat.length < 6 || !(pageWidth > 0)) return out;

  // A caption ("表 1 …", "Table 2 …") always stands alone, even when printed
  // close above the header row.
  const caption = /^(表|图|Table|Fig\.?|Figure)\s*\d/u;
  const clusters: Line[][] = [];
  let afterCaption = false;
  for (const line of flat) {
    const current = clusters[clusters.length - 1];
    const previous = current?.[current.length - 1];
    const isCaption = caption.test(line.text.trim());
    if (
      previous &&
      !isCaption &&
      !afterCaption &&
      previous.y - line.y <= 1.6 * Math.max(previous.size, line.size)
    )
      current!.push(line);
    else clusters.push([line]);
    afterCaption = isCaption;
  }

  interface Row {
    lines: Line[];
    runs: Run[];
    segments: Segment[];
  }
  const build = (cluster: Line[]): Row | null => {
    const runs = attachScripts(cluster.flatMap((line) => line.runs));
    const gap = Math.max(5, textSize(runs) * 0.6);
    // Blank runs (wide padding spaces) must not glue neighbouring cells together.
    const sorted = runs.filter((run) => run.text.trim()).sort((a, b) => a.x - b.x || b.y - a.y);
    const segments: Segment[] = [];
    let end = -Infinity;
    for (const run of sorted) {
      const last = segments[segments.length - 1];
      const previous = last?.runs[last.runs.length - 1];
      // A figure printed at twice the label size starts its own cell even when
      // the horizontal gap is small.
      const sizeJump =
        !!previous &&
        // A small digit/mark beside a larger run is a superscript, not a cell.
        !SCRIPT_TEXT.test((run.size < previous.size ? run : previous).text.trim()) &&
        Math.max(run.size, previous.size) / Math.min(run.size, previous.size) >= 1.5;
      if (!last || run.x - end > gap || sizeJump) {
        segments.push({ x0: run.x, x1: run.x + run.width, runs: [run], text: '' });
      } else {
        last.runs.push(run);
        last.x1 = Math.max(last.x1, run.x + run.width);
      }
      end = Math.max(end, run.x + run.width);
    }
    for (const segment of segments) segment.text = runsText(segment.runs).trim();
    const tooLong = segments.some(
      (segment) => segment.text.length > 30 || segment.x1 - segment.x0 > pageWidth * 0.5,
    );
    return tooLong ? null : { lines: cluster, runs, segments };
  };

  let group: Row[] = [];
  let lastLine: Line | undefined;
  const flush = () => {
    // Captions / titles above or below are single-segment rows: keep them in the flow.
    for (;;) {
      const first = group[0];
      if (first && (first.segments.length < 2 || caption.test(first.segments[0]!.text)))
        group.shift();
      else break;
    }
    while (group.length && group[group.length - 1]!.segments.length < 2) group.pop();
    if (group.length >= 3) {
      const rows = group.map((row) => row.segments);
      const fit = inferColumns(rows, 0.6);
      const texts = rows.flat().map((segment) => segment.text);
      const meanLength = texts.reduce((n, t) => n + t.length, 0) / Math.max(1, texts.length);
      if (fit && meanLength <= 26) {
        const header = looksLikeHeader(rows.map((row) => row.map((segment) => segment.text)))
          ? 1
          : 0;
        const allLines = group.flatMap((row) => row.lines);
        const model = modelFromRows(
          fit,
          segmentRect(rows, allLines),
          header,
          false,
          group.map((row) => row.lines[0]!),
          0,
        );
        if (model) {
          out.tables.push(model);
          for (const line of allLines) out.used.add(line);
        }
      }
    }
    group = [];
  };
  for (const cluster of clusters) {
    const row = build(cluster);
    const top = cluster[0]!;
    // A big vertical hole ends the table region.
    if (lastLine && lastLine.y - top.y > 6 * Math.max(lastLine.size, top.size)) flush();
    if (row) group.push(row);
    else flush();
    lastLine = cluster[cluster.length - 1];
  }
  flush();
  return out;
}

/* -------------------------------- figures -------------------------------- */

const mergeOverlapping = (
  rects: Array<Rect & { vector: boolean; equation?: boolean }>,
  pad: number,
) => {
  const items = rects.map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++)
        if (touches(items[i]!, items[j]!, pad)) {
          items[i] = {
            ...unionRect(items[i]!, items[j]!),
            vector: items[i]!.vector || items[j]!.vector,
            equation: !!items[i]!.equation && !!items[j]!.equation,
          };
          items.splice(j, 1);
          changed = true;
          break outer;
        }
  }
  return items;
};

/**
 * Display equations are often drawn as vector glyph outlines, so no text can
 * be extracted. Cluster small glyph-sized shapes into horizontal bands; a band
 * with several glyphs, no text on the same line and a modest height is an
 * equation on its own line and is kept as a picture. Inline formulas share a
 * line with text and are deliberately left alone. Bigger drawings (charts,
 * diagrams) are handled by the vector figure detector.
 */
function displayFormulaBands(
  shapes: Rect[],
  runs: Run[],
  insideTable: (rect: Rect) => boolean,
  pageWidth: number,
  bodySize: number,
): Rect[] {
  const glyphs = shapes.filter((shape) => {
    const w = shape.x1 - shape.x0;
    const h = shape.y1 - shape.y0;
    return Math.max(w, h) >= 1.5 && w <= bodySize * 4 && h <= bodySize * 3 && !insideTable(shape);
  });
  if (glyphs.length < 3) return [];
  const sorted = [...glyphs].sort((a, b) => b.y1 - a.y1);
  const bands: Array<Rect & { count: number }> = [];
  for (const glyph of sorted) {
    const band = bands.find((b) => glyph.y0 <= b.y1 + 4 && glyph.y1 >= b.y0 - 4);
    if (band) {
      band.x0 = Math.min(band.x0, glyph.x0);
      band.y0 = Math.min(band.y0, glyph.y0);
      band.x1 = Math.max(band.x1, glyph.x1);
      band.y1 = Math.max(band.y1, glyph.y1);
      band.count += 1;
    } else bands.push({ ...glyph, count: 1 });
  }
  return bands.filter((band) => {
    const w = band.x1 - band.x0;
    const h = band.y1 - band.y0;
    // Glyphs of one equation sit close together; scattered marks are not text.
    if (w / band.count > bodySize * 2.2) return false;
    if (band.count < 4 || w < bodySize * 3 || w > pageWidth * 0.95) return false;
    if (h < bodySize * 0.6 || h > bodySize * 8) return false;
    // Any text on the same line makes it an inline formula (or table, caption).
    return !runs.some((run) => {
      const y = run.y + run.size * 0.3;
      return y >= band.y0 - 1 && y <= band.y1 + 1;
    });
  });
}

/**
 * Fraction numerators and denominators are real text sitting just above and
 * below the drawn glyph band. They are short, centred on the band and close to
 * it, and belong to the equation picture. Sentences stay in the text flow.
 */
function formulaFractionRuns(band: Rect, runs: Run[], bodySize: number): Run[] {
  const mid = (band.x0 + band.x1) / 2;
  const rows = new Map<number, Run[]>();
  for (const run of runs) {
    const key = Math.round(run.y / 2);
    rows.set(key, [...(rows.get(key) ?? []), run]);
  }
  const out: Run[] = [];
  for (const row of rows.values()) {
    const { y } = runCenter(row[0]!);
    const gap = y > band.y1 ? y - band.y1 : y < band.y0 ? band.y0 - y : 0;
    // Immediately above/below the glyph band, not a line away.
    if (gap === 0 || gap > bodySize * 1.4) continue;
    const left = Math.min(...row.map((run) => run.x));
    const right = Math.max(...row.map((run) => run.x + run.width));
    const chars = row.reduce((n, run) => n + run.text.trim().length, 0);
    // A fraction part is one short line centred on the equation; prose spans
    // the column or starts at the left margin.
    if (chars > 28 || right - left > (band.x1 - band.x0) * 1.2 + 20) continue;
    if (Math.abs((left + right) / 2 - mid) > Math.max(30, (band.x1 - band.x0) * 0.4)) continue;
    out.push(...row);
  }
  return out;
}

function detectFigures(
  graphics: PdfGraphics,
  tables: Rect[],
  usedRules: Set<Line1D>,
  extraBoxes: Rect[],
  diagrams: Rect[],
  runs: Run[],
  pageWidth: number,
  pageHeight: number,
  bodySize: number,
): FigureRegion[] {
  const pageArea = pageWidth * pageHeight;
  if (!(pageArea > 0)) return [];
  const insideTable = (rect: Rect) => {
    const cx = (rect.x0 + rect.x1) / 2;
    const cy = (rect.y0 + rect.y1) / 2;
    return tables.some((table) => inRect(table, cx, cy, 2));
  };

  const candidates: Array<Rect & { vector: boolean; equation?: boolean }> = [];
  // Raster images. Drop decorations, inline glyph images and page backgrounds.
  for (const image of graphics.images) {
    const w = image.x1 - image.x0;
    const h = image.y1 - image.y0;
    if (insideTable(image)) continue;
    const area = w * h;
    const background = area >= pageArea * 0.6 && runs.length > 0;
    if (background) continue;
    const midY = (image.y0 + image.y1) / 2;
    const inline =
      h <= bodySize * 1.8 &&
      runs.some((run) => Math.abs(run.y + run.size * 0.3 - midY) <= Math.max(h, bodySize) * 0.8);
    if (inline) continue;
    if (area < pageArea * 0.004 && (w < 40 || h < 40)) continue;
    candidates.push({ ...image, vector: false });
  }

  // Vector drawings: cluster shapes/filled boxes/rules that touch each other.
  const members: Rect[] = [];
  for (const shape of [...graphics.shapes, ...graphics.fills]) {
    const w = shape.x1 - shape.x0;
    const h = shape.y1 - shape.y0;
    if (Math.max(w, h) < 6 || insideTable(shape)) continue;
    // A page-sized fill is the paper colour, not drawing content.
    if (w * h >= pageArea * 0.6) continue;
    // So is a full-width fill spanning a large share of the page height.
    if (w >= pageWidth * 0.9 && h >= pageHeight * 0.2) continue;
    // Full-width bands are backgrounds / dividers, not drawing content.
    if (w > pageWidth * 0.85 && h < pageHeight * 0.12) continue;
    members.push(shape);
  }
  for (const seg of graphics.segments) {
    const rect = { x0: seg.x0, y0: seg.y0, x1: seg.x1, y1: seg.y1 };
    if (insideTable(rect)) continue;
    const length = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
    if (length < 6) continue;
    if (
      [...usedRules].some(
        (r) => Math.abs(r.pos - (seg.y0 + seg.y1) / 2) <= TOL && seg.y0 === seg.y1,
      )
    )
      continue;
    members.push(rect);
  }
  for (const box of extraBoxes) members.push(box);
  if (members.length >= 6 && members.length <= 4000) {
    const uf = new UnionFind(members.length);
    const order = members.map((_, i) => i).sort((a, b) => members[a]!.x0 - members[b]!.x0);
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi]!;
      for (let oj = oi + 1; oj < order.length; oj++) {
        const j = order[oj]!;
        if (members[j]!.x0 > members[i]!.x1 + 8) break;
        if (touches(members[i]!, members[j]!, 8)) uf.union(i, j);
      }
    }
    const clusters = new Map<number, number[]>();
    members.forEach((_, i) =>
      (clusters.get(uf.find(i)) ?? clusters.set(uf.find(i), []).get(uf.find(i))!).push(i),
    );
    for (const ids of clusters.values()) {
      if (ids.length < 6) continue;
      let box = members[ids[0]!]!;
      for (const id of ids) box = unionRect(box, members[id]!);
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      if (w < 70 || h < 50 || w * h > pageArea * 0.85) continue;
      const chars = runs
        .filter((run) => {
          const { x, y } = runCenter(run);
          return inRect(box, x, y, 1);
        })
        .reduce((n, run) => n + run.text.trim().length, 0);
      // Prose or table-like boxes carry ~8-12 characters per 1000 pt²; charts
      // and diagrams are far sparser.
      if ((chars / (w * h)) * 1000 >= 5) continue;
      // A sparse code listing in a frame is still text, not a drawing.
      const inBox = runs.filter((run) => {
        const { x, y } = runCenter(run);
        return inRect(box, x, y, 1);
      });
      const mono = inBox.filter((run) => run.font === 'mono').length;
      if (inBox.length >= 2 && mono >= inBox.length * 0.6) continue;
      candidates.push({ ...box, vector: true });
    }
  }

  // Ruled boxes recognised as diagrams (arrows, images, shapes inside), merged
  // with their neighbours into one picture whose labels are suppressed.
  if (diagrams.length) {
    let box = diagrams[0]!;
    for (const d of diagrams) box = unionRect(box, d);
    // Sibling boxes of the same width stacked right above or below (a third
    // frame with a single row) belong to the same diagram.
    for (let grown = true; grown; ) {
      grown = false;
      for (const fill of graphics.fills) {
        const sameWidth = Math.abs(fill.x0 - box.x0) < 3 && Math.abs(fill.x1 - box.x1) < 3;
        const near = fill.y1 >= box.y0 - bodySize * 1.5 && fill.y0 <= box.y1 + bodySize * 1.5;
        const inside = fill.y0 >= box.y0 - 0.5 && fill.y1 <= box.y1 + 0.5;
        if (sameWidth && near && !inside) {
          box = unionRect(box, fill);
          grown = true;
        }
      }
    }
    // Frame names set beside the boxes ("__main__", "cat_twice") are labels of
    // the diagram: widen the picture to include them.
    for (const run of runs) {
      const text = run.text.trim();
      if (!text || text.length > 20 || /\s/u.test(text)) continue;
      const { y } = runCenter(run);
      if (y < box.y0 || y > box.y1) continue;
      const left = run.x + run.width <= box.x0 && box.x0 - (run.x + run.width) < bodySize * 3;
      const right = run.x >= box.x1 && run.x - box.x1 < bodySize * 3;
      if (left || right)
        box = unionRect(box, { x0: run.x, x1: run.x + run.width, y0: box.y0, y1: box.y1 });
    }
    candidates.push({ ...box, vector: true });
  }

  // Equations on their own line become pictures, but never join or overlap a
  // real drawing: that one keeps its own text-suppression rule. Stacked
  // fraction parts are included and their text is dropped from the flow.
  for (const band of displayFormulaBands(graphics.shapes, runs, insideTable, pageWidth, bodySize)) {
    if (candidates.some((c) => touches(c, band, 4))) continue;
    const parts = formulaFractionRuns(band, runs, bodySize);
    let rect: Rect = band;
    for (const run of parts) {
      const { y } = runCenter(run);
      rect = unionRect(rect, {
        x0: run.x,
        x1: run.x + run.width,
        y0: y - run.size * 0.5,
        y1: y + run.size * 0.9,
      });
    }
    candidates.push({ ...rect, vector: parts.length > 0, equation: true });
  }

  const merged = mergeOverlapping(candidates, 3);
  const figures: FigureRegion[] = [];
  for (const item of merged) {
    const rect: Rect = {
      x0: Math.max(0, item.x0 - 2),
      y0: Math.max(0, item.y0 - 2),
      x1: Math.min(pageWidth, item.x1 + 2),
      y1: Math.min(pageHeight, item.y1 + 2),
    };
    if (rect.x1 - rect.x0 < 12 || rect.y1 - rect.y0 < 12) continue;
    if (!tables.some((t) => touches(t, rect) && areaOf(t) > areaOf(rect) * 0.6)) {
      // Short horizontal strokes inside the region (arrows between labels and
      // values) mean a diagram whose labels belong to the picture.
      const arrows = floatingStrokes(graphics.segments, rect);
      figures.push({
        rect,
        suppressText: item.vector || (!item.equation && arrows >= 2),
        equation: item.equation,
      });
    }
  }
  return figures.sort((a, b) => b.rect.y1 - a.rect.y1);
}

/* ------------------------------ orchestration ---------------------------- */

export function analyzeLayout(
  runs: Run[],
  graphics: PdfGraphics | undefined,
  pageWidth: number,
  pageHeight: number,
): LayoutResult {
  const result: LayoutResult = {
    tables: [],
    figures: [],
    flowRuns: runs,
    codeBoxes: [],
    bodySize: 0,
    consumedSegments: 0,
  };
  if (!graphics) return result;
  const upright = runs.filter((run) => !run.rotated);
  const bodySize = upright.length ? textSize(upright) : 10;
  result.bodySize = bodySize;

  const hRules: Line1D[] = [];
  const vRules: Line1D[] = [];
  for (const seg of graphics.segments) {
    if (seg.y0 === seg.y1)
      hRules.push({ pos: seg.y0, a: Math.min(seg.x0, seg.x1), b: Math.max(seg.x0, seg.x1) });
    else if (seg.x0 === seg.x1)
      vRules.push({ pos: seg.x0, a: Math.min(seg.y0, seg.y1), b: Math.max(seg.y0, seg.y1) });
  }
  // A wide shaded box that is not the paper colour is a code listing or call-out.
  const pageArea = pageWidth * pageHeight;
  result.codeBoxes = [...graphics.fills, ...graphics.shapes].filter((box) => {
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    // The paper colour spans (almost) the full page width; code boxes keep margins.
    // Some books paint the page background as one tall rectangle that keeps a
    // narrow margin (e.g. 28pt each side, 91% wide) — it covers the whole text
    // body, so it is paper, never a code listing. A real listing is a short band.
    const wholeBody = h >= pageHeight * 0.6 && w >= pageWidth * 0.8;
    return (
      w >= pageWidth * 0.4 &&
      w <= pageWidth * 0.92 &&
      h >= bodySize * 2.5 &&
      w * h < pageArea &&
      !wholeBody
    );
  });
  const consumed = new Set<Run>();
  const grids = detectGrids(hRules, vRules, upright);
  // A ruled grid holding bitmaps or rounded/curved shapes is a diagram (boxes
  // and arrows of a model figure), not a table: drop it so the figure
  // detector keeps it as a picture.
  const drawn = (rect: Rect, ruledGrid = false) => {
    const pad = 2;
    const hit = (r: Rect) =>
      r.x0 >= rect.x0 - pad &&
      r.x1 <= rect.x1 + pad &&
      r.y0 >= rect.y0 - pad &&
      r.y1 <= rect.y1 + pad;
    const images = graphics.images.filter(hit).length;
    const shapes = graphics.shapes.filter(hit).length;
    // Short rules floating inside cells (arrows "line1 → 'Bing'") mark a
    // diagram as well.
    const arrows = floatingStrokes(graphics.segments, rect);
    // In a fully ruled grid every short piece of cell border looks like a
    // stroke; arrows are only evidence for rule-only (open) frames.
    return images >= 2 || shapes >= 6 || (!ruledGrid && arrows >= 2);
  };
  const diagrams: Rect[] = [];
  for (let i = grids.tables.length - 1; i >= 0; i--) {
    const table = grids.tables[i]!;
    if (!drawn(table.rect, true)) continue;
    for (const cell of table.cells) for (const run of cell.runs) grids.consumedRuns.delete(run);
    grids.rejectedBoxes.push(table.rect);
    diagrams.push(table.rect);
    grids.tables.splice(i, 1);
  }
  grids.consumedRuns.forEach((run) => consumed.add(run));
  // The top and bottom edges of a closed single box (a frame around a code
  // listing or a typeset result) are not table rules.
  const frameEdge = (rule: Line1D) =>
    vRules.filter(
      (v) =>
        (Math.abs(v.pos - rule.a) <= JOIN_TOL || Math.abs(v.pos - rule.b) <= JOIN_TOL) &&
        rule.pos >= v.a - JOIN_TOL &&
        rule.pos <= v.b + JOIN_TOL,
    ).length >= 2;
  // Closed frames with floating arrows inside (a stack diagram's frames) are
  // a drawing: they become one picture, their rules take no part in tables.
  {
    const frames: Rect[] = [];
    const tops = grids.leftoverHorizontals.filter(frameEdge);
    for (const top of tops)
      for (const bottom of tops) {
        if (bottom.pos >= top.pos - bodySize * 1.2) continue;
        if (Math.abs(bottom.a - top.a) > JOIN_TOL || Math.abs(bottom.b - top.b) > JOIN_TOL)
          continue;
        const rect = { x0: top.a, x1: top.b, y0: bottom.pos, y1: top.pos };
        // Nearest bottom only.
        if (frames.some((f) => Math.abs(f.y1 - rect.y1) < 1 && f.y0 > rect.y0)) continue;
        for (let k = frames.length - 1; k >= 0; k--)
          if (Math.abs(frames[k]!.y1 - rect.y1) < 1 && frames[k]!.y0 < rect.y0) frames.splice(k, 1);
        frames.push(rect);
      }
    const drawnFrames = frames.filter((frame) => floatingStrokes(graphics.segments, frame) >= 1);
    if (drawnFrames.length >= 2) diagrams.push(...drawnFrames);
  }
  const ruleOnly = detectRuleTables(
    grids.leftoverHorizontals.filter((rule) => !frameEdge(rule)),
    upright.filter((run) => !consumed.has(run)),
    pageWidth,
    pageHeight,
  );
  // A rule-only table that overlaps a ruled grid already judged a diagram
  // (stacked frames of one drawing) is part of that drawing. Plain rejected
  // boxes (code frames, call-outs) do not count.
  const overlapsDrawn = (rect: Rect) =>
    diagrams.some((box) => touches(box, rect, 2) && areaOf(box) > 0);
  for (let i = ruleOnly.tables.length - 1; i >= 0; i--) {
    const table = ruleOnly.tables[i]!;
    if (!drawn(table.rect) && !overlapsDrawn(table.rect)) continue;
    for (const cell of table.cells) for (const run of cell.runs) ruleOnly.consumedRuns.delete(run);
    diagrams.push(table.rect);
    ruleOnly.tables.splice(i, 1);
  }
  ruleOnly.consumedRuns.forEach((run) => consumed.add(run));
  const tables = [...grids.tables, ...ruleOnly.tables];
  result.consumedSegments = grids.consumed + ruleOnly.usedRules.size;

  const figures = detectFigures(
    graphics,
    tables.map((t) => t.rect),
    ruleOnly.usedRules,
    grids.rejectedBoxes,
    diagrams,
    upright.filter((run) => !consumed.has(run)),
    pageWidth,
    pageHeight,
    bodySize,
  );
  // Axis ticks, legends and node labels sit just outside the drawing's
  // bounding box. Absorb short, body-or-smaller labels hugging a vector figure;
  // full sentences (captions) stay in the text flow.
  // Bitmap figures sometimes carry an invisible text layer of their labels
  // ("统计", "1966 2003 2018"). Text lying wholly inside such a picture, none of
  // it continuing outside on the same line, is already in the picture.
  const rasters = figures.filter((figure) =>
    graphics.images.some(
      (image) =>
        image.x0 >= figure.rect.x0 - 3 &&
        image.x1 <= figure.rect.x1 + 3 &&
        image.y0 >= figure.rect.y0 - 3 &&
        image.y1 <= figure.rect.y1 + 3,
    ),
  );
  const inRaster = (run: Run) => {
    const figure = rasters.find(
      (f) =>
        run.x >= f.rect.x0 - 1 &&
        run.x + run.width <= f.rect.x1 + 1 &&
        run.y >= f.rect.y0 &&
        run.y + run.size * 0.7 <= f.rect.y1 + 1,
    );
    if (!figure) return false;
    // A sentence running across the picture's edge on the same baseline means
    // the picture sits beside text, not under it.
    return !runs.some(
      (other) =>
        other !== run &&
        Math.abs(other.y - run.y) < run.size * 0.3 &&
        (other.x + other.width < figure.rect.x0 - 2 || other.x > figure.rect.x1 + 2),
    );
  };
  // Short, small labels printed hugging a bitmap figure's edge ("h" beside a
  // diagram, "V K Q" under its arrows) belong to the picture even when they
  // stick out a point or two. Full sentences and body-size text stay.
  const hugsRaster = (run: Run) => {
    const text = run.text.trim();
    if (!text || text.length > 14 || run.size > bodySize * 0.95) return false;
    const { x, y } = runCenter(run);
    const pad = Math.max(8, run.size * 1.5);
    const figure = rasters.find((f) => inRect(f.rect, x, y, pad));
    if (!figure) return false;
    return !runs.some(
      (other) =>
        other !== run &&
        Math.abs(other.y - run.y) < run.size * 0.3 &&
        (other.x + other.width < figure.rect.x0 - 2 || other.x > figure.rect.x1 + 2),
    );
  };
  const suppressed = (run: Run) => {
    if (inRaster(run) || hugsRaster(run)) return true;
    const { x, y } = runCenter(run);
    const text = run.text.trim();
    const label =
      text.length <= 14 && (run.size <= bodySize * 0.95 || /^[\d.,%+\-−–\s]+$/u.test(text));
    return figures.some(
      (figure) =>
        figure.suppressText &&
        (inRect(figure.rect, x, y, 1) ||
          (label && inRect(figure.rect, x, y, Math.max(10, run.size * 1.6)))),
    );
  };
  result.tables = tables;
  result.figures = figures;
  result.flowRuns = runs.filter((run) => !consumed.has(run) && !suppressed(run));
  return result;
}

export { detectAlignedTables, detectSparseTables };
