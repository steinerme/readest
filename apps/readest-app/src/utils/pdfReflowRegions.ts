/**
 * Reading regions of a page. Text that is visually separate must never be
 * joined across: a framed or shaded box (a code listing next to its output),
 * the left and right columns of a two-column paper, and a margin note beside
 * the text block. Each run gets a region; lines are built per region and
 * regions are read in their own order (a column top to bottom before the next
 * column, side-by-side boxes left to right).
 *
 * Pure geometry, conservative: when the evidence is weak every run stays in
 * the single body region and the page reads exactly as before.
 */
import type { PdfGraphics, Rect } from './pdfReflowGraphics';
import { textSize, type Run } from './pdfReflowLines';

export interface Region {
  id: number;
  rect: Rect;
  kind: 'body' | 'box' | 'column' | 'margin';
  /** Reading-order key shared by regions read as one unit (a column pair, a
   * row of side-by-side boxes): their content sorts at `groupTop`, then by
   * `groupX`. Body and margin regions sort by each block's own position. */
  groupTop?: number;
  groupX?: number;
}

export interface RegionResult {
  regions: Region[];
  regionOf: Map<Run, number>;
  twoColumns: boolean;
}

const center = (run: Run) => ({ x: run.x + run.width / 2, y: run.y + run.size * 0.3 });
const inside = (rect: Rect, x: number, y: number, pad = 0) =>
  x >= rect.x0 - pad && x <= rect.x1 + pad && y >= rect.y0 - pad && y <= rect.y1 + pad;
const chars = (run: Run) => Math.max(1, run.text.trim().length);

/**
 * Closed rectangles drawn with four rules (framed listings, tcolorbox) and
 * shaded boxes that hold text. Nested boxes keep the innermost.
 */
export type TextBox = Rect & { shaded: boolean };

export function textBoxes(
  graphics: PdfGraphics | undefined,
  runs: Run[],
  pageWidth: number,
  pageHeight: number,
  bodySize: number,
): TextBox[] {
  if (!graphics) return [];
  const boxes: TextBox[] = [];
  // Shaded boxes first, so a frame drawn around the same shading dedupes to it.
  for (const fill of graphics.fills) {
    const w = fill.x1 - fill.x0;
    const ht = fill.y1 - fill.y0;
    if (w >= pageWidth * 0.85 && ht >= pageHeight * 0.2) continue;
    if (w * ht >= pageWidth * pageHeight * 0.5) continue;
    if (ht < bodySize * 1.1 || w < bodySize * 3) continue;
    boxes.push({ ...fill, shaded: true });
  }
  const tol = 1.5;
  const h = graphics.segments.filter((s) => Math.abs(s.y0 - s.y1) < 0.01);
  const v = graphics.segments.filter((s) => Math.abs(s.x0 - s.x1) < 0.01);
  const ruled = h.length <= 400 && v.length <= 400;
  const spans = (y: number, x0: number, x1: number) =>
    h.some(
      (s) =>
        Math.abs(s.y0 - y) <= tol &&
        Math.min(s.x0, s.x1) <= x0 + tol &&
        Math.max(s.x0, s.x1) >= x1 - tol,
    );
  for (const a of ruled ? v : [])
    for (const b of v) {
      if (a.x0 >= b.x0 - bodySize * 2) continue;
      const ay0 = Math.min(a.y0, a.y1);
      const ay1 = Math.max(a.y0, a.y1);
      const by0 = Math.min(b.y0, b.y1);
      const by1 = Math.max(b.y0, b.y1);
      if (Math.abs(ay0 - by0) > tol || Math.abs(ay1 - by1) > tol) continue;
      if (ay1 - ay0 < bodySize * 1.2) continue;
      if (!spans(ay0, a.x0, b.x0) || !spans(ay1, a.x0, b.x0)) continue;
      boxes.push({ x0: a.x0, y0: ay0, x1: b.x0, y1: ay1, shaded: false });
    }
  const holding = boxes.filter((box) =>
    runs.some((run) => {
      const c = center(run);
      return inside(box, c.x, c.y, 0.5);
    }),
  );
  const unique: TextBox[] = [];
  for (const box of holding)
    if (
      !unique.some(
        (u) =>
          Math.abs(u.x0 - box.x0) < 1 &&
          Math.abs(u.x1 - box.x1) < 1 &&
          Math.abs(u.y0 - box.y0) < 1 &&
          Math.abs(u.y1 - box.y1) < 1,
      )
    )
      unique.push(box);
  // A box whose every run is also inside a smaller box is just a frame around
  // it (a shaded inner box inside a ruled outer one): keep the inner one.
  const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);
  return unique.filter(
    (box) =>
      !unique.some(
        (other) =>
          other !== box &&
          area(other) < area(box) &&
          other.x0 >= box.x0 - 0.5 &&
          other.x1 <= box.x1 + 0.5 &&
          other.y0 >= box.y0 - 0.5 &&
          other.y1 <= box.y1 + 0.5,
      ),
  );
}

export interface Gutter {
  x0: number;
  x1: number;
  /** Vertical stretches read as two columns (y0 < y1). */
  stretches: Array<{ y0: number; y1: number }>;
}

/**
 * A vertical gutter near the page middle that splits stretches of the page
 * into two columns. Lines (or tables/figures in `blockers`) crossing the gutter
 * end a stretch; a stretch needs text on both sides over several rows.
 */
export function findGutter(
  runs: Run[],
  pageWidth: number,
  bodySize: number,
  blockers: Rect[] = [],
): Gutter | null {
  const body = runs.filter(
    (r) => !r.rotated && r.size >= bodySize * 0.7 && r.size <= bodySize * 1.4,
  );
  if (body.length < 40 || !(pageWidth > 0)) return null;
  const lo = pageWidth * 0.38;
  const hi = pageWidth * 0.62;
  let best: { x: number; crossing: number } | null = null;
  for (let x = lo; x <= hi; x += 1) {
    let left = 0;
    let right = 0;
    let crossing = 0;
    for (const run of body) {
      if (run.x + run.width <= x - 2) left += chars(run);
      else if (run.x >= x + 2) right += chars(run);
      else crossing += chars(run);
    }
    const total = left + right + crossing;
    if (crossing > total * 0.15 || left < total * 0.25 || right < total * 0.25) continue;
    if (!best || crossing < best.crossing) best = { x, crossing };
  }
  if (!best) return null;
  const gx = best.x;
  // Column edges: most lines on each side start at the same x.
  const share = (xs: number[]) => {
    const count = new Map<number, number>();
    for (const x of xs) for (const d of [-1, 0, 1]) count.set(x + d, (count.get(x + d) ?? 0) + 1);
    return Math.max(0, ...count.values()) / Math.max(1, xs.length);
  };
  const leftStarts = body.filter((r) => r.x + r.width <= gx).map((r) => Math.round(r.x));
  const rightStarts = body.filter((r) => r.x >= gx).map((r) => Math.round(r.x));
  // A wide table also has an empty vertical band, but its two halves share
  // every baseline and hold short cells (numbers), not running text. Real
  // columns carry long lines, and their baselines need not coincide.
  {
    const sideRows = new Map<number, { l: number; r: number }>();
    for (const run of body) {
      const key = Math.round(run.y);
      const row = sideRows.get(key) ?? { l: 0, r: 0 };
      if (run.x + run.width <= gx) row.l += 1;
      else if (run.x >= gx) row.r += 1;
      sideRows.set(key, row);
    }
    const rows = [...sideRows.values()];
    const both = rows.filter((row) => row.l && row.r).length;
    const longRuns = body.filter((run) => run.width > (pageWidth / 2) * 0.6).length;
    if (both >= rows.length * 0.8 && longRuns < body.length * 0.2) return null;
  }
  const ls = share(leftStarts);
  const rs = share(rightStarts);
  if (Math.min(ls, rs) < 0.12 || Math.max(ls, rs) < 0.25) return null;

  // Rows top to bottom: two-sided, one-sided, or crossing.
  type Row = { y: number; l: boolean; r: boolean; cross: boolean };
  const rows = new Map<number, Row>();
  for (const run of body) {
    const key = Math.round(run.y);
    const row = rows.get(key) ?? { y: run.y, l: false, r: false, cross: false };
    if (run.x + run.width <= gx + 1) row.l = true;
    else if (run.x >= gx - 1) row.r = true;
    else row.cross = true;
    rows.set(key, row);
  }
  const ordered = [...rows.values()].sort((a, b) => b.y - a.y);
  const crossingBlocker = (y: number) =>
    blockers.some((b) => b.x0 < gx - 4 && b.x1 > gx + 4 && y <= b.y1 && y >= b.y0);
  // Column baselines need not line up, so a stretch is judged by how many
  // lines it has on each side, not by rows with text on both.
  type Stretch = { y0: number; y1: number; left: number; right: number };
  const stretches: Stretch[] = [];
  let current: Stretch | null = null;
  const close = () => {
    if (current && current.left >= 4 && current.right >= 4) stretches.push(current);
    current = null;
  };
  let lastCross: number | null = null;
  for (const row of ordered) {
    if (row.cross || crossingBlocker(row.y)) {
      close();
      lastCross = row.y;
      continue;
    }
    // The short last line of a full-width paragraph (a caption ending in
    // "tions/answers).") sits on the left side right below the crossing rows:
    // it belongs to that paragraph, not to the left column.
    if (!current && lastCross !== null && row.l && !row.r && lastCross - row.y <= bodySize * 1.6) {
      lastCross = row.y;
      continue;
    }
    if (!current) current = { y0: row.y, y1: row.y, left: 0, right: 0 };
    current.y0 = row.y;
    if (row.l) current.left += 1;
    if (row.r) current.right += 1;
  }
  close();
  // Blockers themselves end stretches even with no text rows inside.
  const split: Array<{ y0: number; y1: number }> = [];
  for (const s of stretches) {
    let pieces = [{ y0: s.y0, y1: s.y1 }];
    for (const b of blockers) {
      if (!(b.x0 < gx - 4 && b.x1 > gx + 4)) continue;
      pieces = pieces.flatMap((p) =>
        b.y1 < p.y0 || b.y0 > p.y1
          ? [p]
          : [
              ...(p.y1 > b.y1 ? [{ y0: b.y1, y1: p.y1 }] : []),
              ...(p.y0 < b.y0 ? [{ y0: p.y0, y1: b.y0 }] : []),
            ],
      );
    }
    split.push(...pieces);
  }
  // Pad by less than a line: the next full-width row (a caption's last line)
  // must stay outside the stretch.
  const padded = split
    .filter((s) => s.y1 - s.y0 >= bodySize * 4)
    .map((s) => ({ y0: s.y0 - bodySize * 0.4, y1: s.y1 + bodySize * 0.4 }));
  if (!padded.length) return null;
  // Tables and figures that sit entirely on one side extend the stretch they
  // touch: their text is gone from `body`, but they are column content.
  const oneSide = blockers.filter((b) => b.x1 <= gx + 2 || b.x0 >= gx - 2);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of padded)
      for (const b of oneSide) {
        const near = b.y0 <= s.y1 + bodySize * 3 && b.y1 >= s.y0 - bodySize * 3;
        if (!near) continue;
        const crossing = (y0: number, y1: number) =>
          ordered.some((row) => row.cross && row.y >= y0 && row.y <= y1) ||
          blockers.some((o) => o.x0 < gx - 4 && o.x1 > gx + 4 && o.y1 >= y0 && o.y0 <= y1);
        if (b.y1 > s.y1 && !crossing(s.y1, b.y1)) {
          s.y1 = b.y1 + 1;
          changed = true;
        }
        if (b.y0 < s.y0 && !crossing(b.y0, s.y0)) {
          s.y0 = b.y0 - 1;
          changed = true;
        }
      }
  }
  // Gutter width over the stretches.
  const inStretch = (r: Run) => padded.some((s) => r.y >= s.y0 && r.y <= s.y1);
  const leftEdge = Math.max(
    0,
    ...body.filter((r) => inStretch(r) && r.x + r.width <= gx + 1).map((r) => r.x + r.width),
  );
  const rightEdge = Math.min(
    pageWidth,
    ...body.filter((r) => inStretch(r) && r.x >= gx - 1).map((r) => r.x),
  );
  if (rightEdge - leftEdge < bodySize * 0.6) return null;
  return { x0: leftEdge, x1: rightEdge, stretches: padded };
}

/** Assign every run to a region. Precedence: boxes, margin notes, columns. */
export function assignRegions(
  runs: Run[],
  graphics: PdfGraphics | undefined,
  pageWidth: number,
  pageHeight: number,
  blockers: Rect[] = [],
): RegionResult {
  const regions: Region[] = [
    { id: 0, rect: { x0: 0, y0: 0, x1: pageWidth, y1: pageHeight }, kind: 'body' },
  ];
  const regionOf = new Map<Run, number>();
  for (const run of runs) regionOf.set(run, 0);
  const upright = runs.filter((r) => !r.rotated);
  if (!upright.length) return { regions, regionOf, twoColumns: false };
  const bodySize = textSize(upright);

  const boxes = textBoxes(graphics, upright, pageWidth, pageHeight, bodySize);
  // Side-by-side boxes form one row read left to right.
  const sorted = [...boxes].sort((a, b) => b.y1 - a.y1);
  const rows: Rect[][] = [];
  for (const box of sorted) {
    const row = rows.find((r) =>
      r.some((o) => Math.min(o.y1, box.y1) - Math.max(o.y0, box.y0) > bodySize),
    );
    if (row) row.push(box);
    else rows.push([box]);
  }
  for (const row of rows) {
    const top = Math.max(...row.map((b) => b.y1));
    for (const box of row) {
      const id = regions.length;
      regions.push({ id, rect: box, kind: 'box', groupTop: top, groupX: box.x0 });
      for (const run of upright) {
        const c = center(run);
        if (regionOf.get(run) === 0 && inside(box, c.x, c.y, 0.5)) regionOf.set(run, id);
      }
    }
  }

  // Margin notes: small text outside the edges the body text never passes.
  const free = upright.filter((run) => regionOf.get(run) === 0);
  const bodyRuns = free.filter((r) => r.size >= bodySize * 0.9);
  if (bodyRuns.length >= 10) {
    const rights = bodyRuns.map((r) => r.x + r.width).sort((a, b) => a - b);
    const lefts = bodyRuns.map((r) => r.x).sort((a, b) => a - b);
    const right = rights[Math.floor(rights.length * 0.98)]!;
    const left = lefts[Math.floor(lefts.length * 0.02)]!;
    const notes = free.filter(
      (r) =>
        r.size < bodySize * 0.92 &&
        (r.x >= right + bodySize * 0.5 || r.x + r.width <= left - bodySize * 0.5),
    );
    if (notes.length) {
      const id = regions.length;
      regions.push({
        id,
        rect: {
          x0: Math.min(...notes.map((r) => r.x)),
          y0: Math.min(...notes.map((r) => r.y)),
          x1: Math.max(...notes.map((r) => r.x + r.width)),
          y1: Math.max(...notes.map((r) => r.y + r.size)),
        },
        kind: 'margin',
      });
      for (const run of notes) regionOf.set(run, id);
    }
  }

  const remaining = upright.filter((run) => regionOf.get(run) === 0);
  const gutter = findGutter(remaining, pageWidth, bodySize, [...blockers, ...boxes]);
  if (!gutter) return { regions, regionOf, twoColumns: false };
  for (const stretch of gutter.stretches) {
    const leftId = regions.length;
    regions.push({
      id: leftId,
      rect: { x0: 0, y0: stretch.y0, x1: gutter.x0, y1: stretch.y1 },
      kind: 'column',
      groupTop: stretch.y1,
      groupX: 0,
    });
    const rightId = regions.length;
    regions.push({
      id: rightId,
      rect: { x0: gutter.x1, y0: stretch.y0, x1: pageWidth, y1: stretch.y1 },
      kind: 'column',
      groupTop: stretch.y1,
      groupX: gutter.x1,
    });
    for (const run of remaining) {
      if (run.y < stretch.y0 || run.y > stretch.y1) continue;
      if (run.x + run.width <= gutter.x0 + 1) regionOf.set(run, leftId);
      else if (run.x >= gutter.x1 - 1) regionOf.set(run, rightId);
    }
  }
  return { regions, regionOf, twoColumns: true };
}

/** Region holding a point (innermost box first, then columns). */
export function regionAt(regions: Region[], x: number, y: number): Region {
  const hit = regions
    .filter((r) => r.kind !== 'body' && r.kind !== 'margin' && inside(r.rect, x, y, 1))
    .sort(
      (a, b) =>
        (a.rect.x1 - a.rect.x0) * (a.rect.y1 - a.rect.y0) -
        (b.rect.x1 - b.rect.x0) * (b.rect.y1 - b.rect.y0),
    );
  return hit[0] ?? regions[0]!;
}
