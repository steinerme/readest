/**
 * Inline formulas typeset with text glyphs that span several baselines: a
 * fraction, a sum with limits or a radical with an index inside a sentence
 * ("P_i = e^{S·T_i} / Σ_j e^{S·T_j}"). Line grouping pulls their pieces apart
 * (numerator merged into the line above, denominator into a separate note).
 * A run of math-font glyphs that rises well above or drops well below the line
 * it belongs to is taken out of the text and shown as one small picture.
 *
 * Plain sub/superscripts (x², T_i) stay text: they are within a line's reach.
 */
import type { InlineEquation } from './pdfReflowInline';
import type { Line, Run } from './pdfReflowLines';

const isMath = (run: Run) =>
  run.font === 'math' || (!!run.fontName && /^cm(r|bx)\d|^rtxr|^txr/i.test(run.fontName));

export interface InlineTextFormula {
  line: Line;
  equation: InlineEquation;
  runs: Set<Run>;
}

/**
 * @param lines body lines (already built, before block joining)
 * @param all   every flow run, to collect stacked pieces on other baselines
 */
export function findInlineTextFormulas(
  lines: Line[],
  all: Run[],
  bodySize: number,
): InlineTextFormula[] {
  const out: InlineTextFormula[] = [];
  if (!(bodySize > 0)) return out;
  const taken = new Set<Run>();
  for (const line of lines) {
    if (line.size < bodySize * 0.85 || line.size > bodySize * 1.2) continue;
    const prose = line.runs.filter((run) => !isMath(run) && run.text.trim());
    if (!prose.length) continue;
    // Big operators (Σ, ∫, √ in an extension font) on this line mark a stacked
    // inline formula; their limits and fraction parts sit above and below.
    for (const anchor of line.runs) {
      if (taken.has(anchor) || anchor.font !== 'math') continue;
      if (!/^cmex|^txex|^yhcmex|^pxex/i.test(anchor.fontName ?? '')) continue;
      // Grow a cluster of math glyphs horizontally connected to the anchor,
      // within a band of ±1.1 line sizes around the line.
      const band = (run: Run) =>
        run.y >= line.y - line.size * 1.1 && run.y <= line.y + line.size * 1.1;
      const cluster: Run[] = [anchor];
      let x0 = anchor.x;
      let x1 = anchor.x + anchor.width;
      for (let grown = true; grown; ) {
        grown = false;
        for (const run of all) {
          if (taken.has(run) || cluster.includes(run) || !isMath(run) || !band(run)) continue;
          if (run.x > x1 + bodySize * 0.35 || run.x + run.width < x0 - bodySize * 0.35) continue;
          cluster.push(run);
          x0 = Math.min(x0, run.x);
          x1 = Math.max(x1, run.x + run.width);
          grown = true;
        }
      }
      // Leading math on the same baseline right before the cluster (P_i =).
      const offLine = cluster.filter((run) => Math.abs(run.y - line.y) > line.size * 0.45);
      if (offLine.length < 2) continue;
      const tight = (run: Run) =>
        run.x + run.width >= x0 - bodySize * 0.6 && Math.abs(run.y - line.y) <= line.size * 0.45;
      for (const run of line.runs)
        if (!cluster.includes(run) && isMath(run) && tight(run) && run.x < x0) {
          cluster.push(run);
          x0 = Math.min(x0, run.x);
        }
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const run of cluster) {
        y0 = Math.min(y0, run.y - run.size * 0.3);
        y1 = Math.max(y1, run.y + run.size * 0.85);
        taken.add(run);
      }
      x1 = Math.max(...cluster.map((run) => run.x + run.width));
      out.push({
        line,
        runs: new Set(cluster),
        equation: {
          x0: x0 - 1,
          y0: y0 - 1,
          x1: x1 + 1,
          y1: y1 + 1,
          bodySize,
          descent: (line.y - (y0 - 1)) / bodySize,
        },
      });
    }
  }
  return out;
}
