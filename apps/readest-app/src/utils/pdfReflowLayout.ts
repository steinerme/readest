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
}

export interface LayoutResult {
  tables: TableModel[];
  figures: FigureRegion[];
  flowRuns: Run[];
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
        result.rejectedBoxes.push({
          x0: Math.min(...xs),
          x1: Math.max(...xs),
          y0: Math.min(...ys),
          y1: Math.max(...ys),
        });
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
  for (const run of line.runs) {
    // Blank runs are padding: they neither start a segment nor extend one.
    if (!run.text.trim()) continue;
    if (!current || run.x - end > gap) {
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
    if (
      mergeContinuations &&
      previous &&
      firstEmpty &&
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
  const groups: Line1D[][] = [];
  let current: Line1D[] = [];
  for (const rule of long) {
    const first = current[0];
    if (
      first &&
      sameExtent(first, rule) &&
      first.pos - rule.pos <= pageHeight * 0.6 &&
      runs.some((run) => run.y > rule.pos && run.y < current[current.length - 1]!.pos)
    ) {
      current.push(rule);
    } else {
      if (current.length >= 2) groups.push(current);
      current = [rule];
    }
  }
  if (current.length >= 2) groups.push(current);

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
    const fit = inferColumns(segments, 0.5);
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

function detectAlignedTables(
  lines: Line[],
  pageWidth: number,
): { tables: TableModel[]; used: Set<Line> } {
  const out = { tables: [] as TableModel[], used: new Set<Line>() };
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

const mergeOverlapping = (rects: Array<Rect & { vector: boolean }>, pad: number) => {
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
          };
          items.splice(j, 1);
          changed = true;
          break outer;
        }
  }
  return items;
};

function detectFigures(
  graphics: PdfGraphics,
  tables: Rect[],
  usedRules: Set<Line1D>,
  extraBoxes: Rect[],
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

  const candidates: Array<Rect & { vector: boolean }> = [];
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
      candidates.push({ ...box, vector: true });
    }
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
    if (!tables.some((t) => touches(t, rect) && areaOf(t) > areaOf(rect) * 0.6))
      figures.push({ rect, suppressText: item.vector });
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
  const result: LayoutResult = { tables: [], figures: [], flowRuns: runs, consumedSegments: 0 };
  if (!graphics) return result;
  const upright = runs.filter((run) => !run.rotated);
  const bodySize = upright.length ? textSize(upright) : 10;

  const hRules: Line1D[] = [];
  const vRules: Line1D[] = [];
  for (const seg of graphics.segments) {
    if (seg.y0 === seg.y1)
      hRules.push({ pos: seg.y0, a: Math.min(seg.x0, seg.x1), b: Math.max(seg.x0, seg.x1) });
    else if (seg.x0 === seg.x1)
      vRules.push({ pos: seg.x0, a: Math.min(seg.y0, seg.y1), b: Math.max(seg.y0, seg.y1) });
  }
  const consumed = new Set<Run>();
  const grids = detectGrids(hRules, vRules, upright);
  grids.consumedRuns.forEach((run) => consumed.add(run));
  const ruleOnly = detectRuleTables(
    grids.leftoverHorizontals,
    upright.filter((run) => !consumed.has(run)),
    pageWidth,
    pageHeight,
  );
  ruleOnly.consumedRuns.forEach((run) => consumed.add(run));
  const tables = [...grids.tables, ...ruleOnly.tables];
  result.consumedSegments = grids.consumed + ruleOnly.usedRules.size;

  const figures = detectFigures(
    graphics,
    tables.map((t) => t.rect),
    ruleOnly.usedRules,
    grids.rejectedBoxes,
    upright.filter((run) => !consumed.has(run)),
    pageWidth,
    pageHeight,
    bodySize,
  );
  // Axis ticks, legends and node labels sit just outside the drawing's
  // bounding box. Absorb short, body-or-smaller labels hugging a vector figure;
  // full sentences (captions) stay in the text flow.
  const suppressed = (run: Run) => {
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
