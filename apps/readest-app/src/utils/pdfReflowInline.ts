/**
 * Inline equations drawn as vector glyph outlines have no extractable text, so
 * a sentence such as "其中 D_c 是类别 c 的样本集合" loses its symbols. Here the
 * glyph outlines that sit between the words of a body line are clustered and
 * attached to that line; the reflow keeps an invisible marker where each one
 * belongs and the reader shows a small picture of the page region in its place.
 */
import type { Rect } from './pdfReflowGraphics';
import type { Line } from './pdfReflowLines';

/** Invisible stand-in for an inline equation picture inside block text. It is
 * not part of the PDF item stream, so its source offset is always -1. */
export const INLINE_EQUATION_MARK = '\u2060';

export interface InlineEquation extends Rect {
  /** PDF units: the picture's region (padded by 1pt). */
  /** Body text size of the page; the picture is drawn at the same scale. */
  bodySize: number;
  /** How far the region reaches below the text baseline, in body-size units. */
  descent: number;
}

const inside = (rect: Rect, x: number, y: number) =>
  x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;

/** Cluster glyph-sized shapes: horizontal neighbours within a word space, any
 * vertical neighbour that overlaps (sub/superscripts, fraction parts). */
function clusterGlyphs(glyphs: Rect[], bodySize: number): Array<Rect & { count: number }> {
  const parent = glyphs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const padX = bodySize * 0.5;
  const padY = 1.5;
  const order = glyphs.map((_, i) => i).sort((a, b) => glyphs[a]!.x0 - glyphs[b]!.x0);
  for (let oi = 0; oi < order.length; oi++) {
    const a = glyphs[order[oi]!]!;
    for (let oj = oi + 1; oj < order.length; oj++) {
      const b = glyphs[order[oj]!]!;
      if (b.x0 > a.x1 + padX + bodySize * 12) break;
      if (b.x0 <= a.x1 + padX && b.x1 >= a.x0 - padX && b.y0 <= a.y1 + padY && b.y1 >= a.y0 - padY)
        parent[find(order[oj]!)] = find(order[oi]!);
    }
  }
  const groups = new Map<number, Rect & { count: number }>();
  glyphs.forEach((glyph, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (!group) groups.set(root, { ...glyph, count: 1 });
    else {
      group.x0 = Math.min(group.x0, glyph.x0);
      group.y0 = Math.min(group.y0, glyph.y0);
      group.x1 = Math.max(group.x1, glyph.x1);
      group.y1 = Math.max(group.y1, glyph.y1);
      group.count += 1;
    }
  });
  return [...groups.values()];
}

/**
 * Find inline equations and the body line each belongs to. A cluster is an
 * inline equation only when it is as tall as text (not a bullet dot, not a
 * drawing), sits on a body-size line's baseline, touches that line's words
 * (within a couple of characters) and covers none of them.
 */
export function findInlineEquations(
  shapes: Rect[],
  lines: Line[],
  bodySize: number,
  exclude: Rect[],
  skip: Set<Line>,
): Map<Line, InlineEquation[]> {
  const result = new Map<Line, InlineEquation[]>();
  if (!(bodySize > 0) || !shapes.length) return result;
  const glyphs = shapes.filter((shape) => {
    const w = shape.x1 - shape.x0;
    const h = shape.y1 - shape.y0;
    if (Math.max(w, h) < 1.5 || w > bodySize * 6 || h > bodySize * 3) return false;
    const cx = (shape.x0 + shape.x1) / 2;
    const cy = (shape.y0 + shape.y1) / 2;
    return !exclude.some((rect) => inside(rect, cx, cy));
  });
  // Pages crowded with shapes are charts or diagrams, not running text.
  if (glyphs.length < 1 || glyphs.length > 1200) return result;
  const candidates = lines.filter(
    (line) =>
      !skip.has(line) &&
      line.size >= bodySize * 0.85 &&
      line.size <= bodySize * 1.15 &&
      line.runs.every((run) => !run.rotated),
  );
  interface Found {
    cluster: Rect;
    line: Line;
    tiny: boolean;
    gap: number;
    accepted: boolean;
  }
  const found: Found[] = [];
  for (const cluster of clusterGlyphs(glyphs, bodySize)) {
    const w = cluster.x1 - cluster.x0;
    const h = cluster.y1 - cluster.y0;
    // A single letter ("i", "c") is only ~0.5 em tall; anything smaller is a
    // bullet dot, accent or rule fragment. Tiny marks must sit right against
    // the words (or another equation part) to count.
    const tiny = Math.max(w, h) < bodySize * 0.55;
    // Text-height symbols only: a bullet dot or rule fragment is far smaller,
    // a drawing far larger.
    if (Math.max(w, h) < bodySize * 0.3 || w > bodySize * 24 || h > bodySize * 3.2) continue;
    let best: { line: Line; gap: number } | undefined;
    for (const line of candidates) {
      const size = line.size;
      // The cluster must rest on this baseline and rise to roughly x-height.
      if (cluster.y0 > line.y + size * 0.25 || cluster.y1 < line.y + size * 0.3) continue;
      if (cluster.y0 < line.y - size * 1.3 || cluster.y1 > line.y + size * 1.7) continue;
      let gap = Infinity;
      let covers = false;
      for (const run of line.runs) {
        const d = Math.max(run.x - cluster.x1, cluster.x0 - (run.x + run.width), 0);
        if (d === 0) covers = true;
        gap = Math.min(gap, d);
      }
      if (covers) continue;
      if (!best || gap < best.gap) best = { line, gap };
    }
    if (best) found.push({ cluster, line: best.line, tiny, gap: best.gap, accepted: false });
  }
  const near = (item: Found) => item.line.size * (item.tiny ? 0.6 : 1.6);
  for (const item of found) item.accepted = item.gap <= near(item);
  // An equation is often drawn as several pieces (a function name, its
  // arguments, an operator). A piece too far from the words still belongs when
  // it touches an accepted piece of the same line with no word in between.
  const between = (line: Line, from: number, to: number) =>
    line.runs.some((run) => run.x + run.width > from + 0.5 && run.x < to - 0.5);
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of found) {
      if (item.accepted) continue;
      // Small marks (a bullet dot) may only join when practically touching.
      const limit = item.line.size * (item.tiny ? 0.4 : 1.6);
      const joins = found.some((other) => {
        if (!other.accepted || other.line !== item.line) return false;
        const gap = Math.max(
          other.cluster.x0 - item.cluster.x1,
          item.cluster.x0 - other.cluster.x1,
          0,
        );
        if (gap > limit) return false;
        const from = Math.min(item.cluster.x1, other.cluster.x1);
        const to = Math.max(item.cluster.x0, other.cluster.x0);
        return !between(item.line, from, to);
      });
      if (joins) {
        item.accepted = true;
        changed = true;
      }
    }
  }
  const byLine = new Map<Line, Rect[]>();
  for (const item of found) {
    if (!item.accepted) continue;
    byLine.set(item.line, [...(byLine.get(item.line) ?? []), item.cluster]);
  }
  for (const [line, clusters] of byLine) {
    clusters.sort((a, b) => a.x0 - b.x0);
    // Pieces with no word between them are one equation, one picture.
    const merged: Rect[] = [];
    for (const piece of clusters) {
      const last = merged[merged.length - 1];
      if (last && piece.x0 - last.x1 <= line.size * 2.2 && !between(line, last.x1, piece.x0)) {
        last.x0 = Math.min(last.x0, piece.x0);
        last.y0 = Math.min(last.y0, piece.y0);
        last.x1 = Math.max(last.x1, piece.x1);
        last.y1 = Math.max(last.y1, piece.y1);
      } else merged.push({ ...piece });
    }
    result.set(
      line,
      merged.map((rect) => ({
        x0: rect.x0 - 1,
        y0: rect.y0 - 1,
        x1: rect.x1 + 1,
        y1: rect.y1 + 1,
        bodySize,
        descent: (line.y - (rect.y0 - 1)) / bodySize,
      })),
    );
  }
  for (const list of result.values()) list.sort((a, b) => a.x0 - b.x0);
  return result;
}
