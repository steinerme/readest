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
  for (const cluster of clusterGlyphs(glyphs, bodySize)) {
    const w = cluster.x1 - cluster.x0;
    const h = cluster.y1 - cluster.y0;
    // Text-height symbols only: a bullet dot or rule fragment is far smaller,
    // a drawing far larger.
    // A single letter ("i", "c") is only ~0.5 em tall; anything smaller is a
    // bullet dot, accent or rule fragment. Tiny marks must sit right against
    // the words to count.
    const tiny = Math.max(w, h) < bodySize * 0.55;
    if (Math.max(w, h) < bodySize * 0.3 || w > bodySize * 12 || h > bodySize * 3.2) continue;
    let best: { line: Line; distance: number } | undefined;
    for (const line of candidates) {
      const size = line.size;
      // The cluster must rest on this baseline and rise to roughly x-height.
      if (cluster.y0 > line.y + size * 0.25 || cluster.y1 < line.y + size * 0.3) continue;
      if (cluster.y0 < line.y - size * 1.3 || cluster.y1 > line.y + size * 1.7) continue;
      let distance = Infinity;
      let covers = false;
      for (const run of line.runs) {
        const gap = Math.max(run.x - cluster.x1, cluster.x0 - (run.x + run.width), 0);
        if (gap === 0) covers = true;
        distance = Math.min(distance, gap);
      }
      if (covers || distance > size * (tiny ? 0.6 : 1.6)) continue;
      if (!best || distance < best.distance) best = { line, distance };
    }
    if (!best) continue;
    const { line } = best;
    const list = result.get(line) ?? [];
    list.push({
      x0: cluster.x0 - 1,
      y0: cluster.y0 - 1,
      x1: cluster.x1 + 1,
      y1: cluster.y1 + 1,
      bodySize,
      descent: (line.y - (cluster.y0 - 1)) / bodySize,
    });
    result.set(line, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.x0 - b.x0);
  return result;
}
