/**
 * Display formulas typeset with text glyphs (TeX math fonts, Symbol). Their
 * pieces sit on several baselines (fraction parts, sub/superscripts, big
 * delimiters, matrix rows), so line-by-line reflow scatters them into loose
 * digits and private-use glyphs. A band of lines made only of math is kept
 * whole and shown as a picture of the page region instead.
 *
 * Requires real font names (Run.fontName). Without them nothing is detected.
 */
import type { Rect, RuleSegment } from './pdfReflowGraphics';
import { buildLines, type Line, type Run } from './pdfReflowLines';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Characters that carry no language: digits, operators, brackets, punctuation.
const NEUTRAL =
  /^[\s\d.,:;!?'"`’”“()[\]{}<>=+\-−–—*/\\|^_~·•…%#&@$∗∘×÷±∓≤≥≠≈≡∼→←↔⇒⇔∈∉⊂⊆∪∩∑∏∫√∞∂∇]+$/u;
// Roman math fonts: digits, function names and operators inside formulas.
const MATH_ROMAN = /^(cmr\d|cmbx\d|rtxr|txr|pxr|cmmib|eurm)/i;

export interface FormulaRegion extends Rect {
  runs: Run[];
}

function isMathRun(run: Run, romanIsMath: boolean): boolean {
  if (run.font === 'math') return true;
  return romanIsMath && !!run.fontName && MATH_ROMAN.test(run.fontName);
}

/** Prose characters: letters in text fonts, except one- to three-letter words
 * ("if", "or", "Hz", "Cs") that formulas use for units and conditions. */
function proseChars(run: Run): number {
  const text = run.text.trim();
  if (!text || NEUTRAL.test(text)) return 0;
  if (CJK.test(text)) return text.length + 10;
  let n = 0;
  for (const word of text.split(/[\s\d.,:;()[\]{}=+\-−–*/\\|]+/u))
    if (word.length > 3) n += word.length;
  return n;
}

type Kind = 'math' | 'neutral' | 'prose';

function classify(
  line: Line,
  romanIsMath: boolean,
  bodyFont: string,
): { kind: Kind; math: number } {
  let math = 0;
  let prose = 0;
  let body = 0;
  for (const run of line.runs) {
    if (run.font === 'mono') return { kind: 'prose', math: 0 };
    const n = run.text.trim().length;
    if (isMathRun(run, romanIsMath)) math += n;
    // A small word set as a subscript in text font ("d_model") is part of
    // the formula around it.
    else if (run.size < line.size * 0.75) continue;
    else {
      prose += proseChars(run);
      // Text in the page's body font (numbers in a table, "MoE [32]") is not
      // part of a typeset formula.
      if (run.fontName === bodyFont) body += n;
    }
  }
  if (prose > 0 || body > math) return { kind: 'prose', math };
  return { kind: math > 0 ? 'math' : 'neutral', math };
}

/**
 * @param runs   flow runs (tables already removed)
 * @param segments page rules; fraction bars inside a band are included
 */
export function textFormulaRegions(
  runs: Run[],
  segments: RuleSegment[],
  pageWidth: number,
  pageHeight: number,
  bodySize: number,
): FormulaRegion[] {
  const upright = runs.filter((run) => !run.rotated);
  if (!upright.some((run) => run.font === 'math')) return [];
  // When the body itself is set in Computer Modern Roman, cmr is prose.
  const counts = new Map<string, number>();
  for (const run of upright)
    if (run.fontName) counts.set(run.fontName, (counts.get(run.fontName) ?? 0) + run.text.length);
  const bodyFont = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const romanIsMath = !MATH_ROMAN.test(bodyFont);

  const { lines } = buildLines(upright, pageWidth);
  const info = lines.map((line) => ({ line, ...classify(line, romanIsMath, bodyFont) }));
  const top = (line: Line) => line.y + line.size * 0.9;
  const bottom = (line: Line) => line.y - line.size * 0.3;

  // Group vertically adjacent math/neutral lines that overlap horizontally.
  const groups: Array<typeof info> = [];
  for (const item of info) {
    if (item.kind === 'prose') continue;
    const group = groups.find((g) =>
      g.some((other) => {
        const vgap = Math.max(
          bottom(other.line) - top(item.line),
          bottom(item.line) - top(other.line),
          0,
        );
        const hgap = Math.max(other.line.x - item.line.end, item.line.x - other.line.end, 0);
        return vgap <= bodySize * 0.9 && hgap <= bodySize * 6;
      }),
    );
    if (group) group.push(item);
    else groups.push([item]);
  }
  // Merge groups that became adjacent through later members.
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const touch = groups[i]!.some((a) =>
          groups[j]!.some((b) => {
            const vgap = Math.max(bottom(a.line) - top(b.line), bottom(b.line) - top(a.line), 0);
            const hgap = Math.max(a.line.x - b.line.end, b.line.x - a.line.end, 0);
            return vgap <= bodySize * 0.9 && hgap <= bodySize * 6;
          }),
        );
        if (touch) {
          groups[i]!.push(...groups.splice(j, 1)[0]!);
          changed = true;
          break outer;
        }
      }
  }

  const prose = info.filter((item) => item.kind === 'prose').map((item) => item.line);
  const regions: FormulaRegion[] = [];
  for (const group of groups) {
    const math = group.reduce((n, item) => n + item.math, 0);
    const mathLines = group.filter((item) => item.kind === 'math').length;
    if (!mathLines || (math < 3 && group.length < 2)) continue;
    let rect: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const members: Run[] = [];
    for (const { line } of group)
      for (const run of line.runs) {
        members.push(run);
        rect = {
          x0: Math.min(rect.x0, run.x),
          x1: Math.max(rect.x1, run.x + run.width),
          y0: Math.min(rect.y0, run.y - run.size * 0.3),
          y1: Math.max(rect.y1, run.y + run.size * 0.9),
        };
      }
    if (rect.y1 - rect.y0 > pageHeight * 0.5 || rect.x1 - rect.x0 > pageWidth * 0.95) continue;
    // A short single-line piece ("PE_pos.", "P_drop = 0.1.") is the tail of a
    // sentence wrapped onto its own line, not a display formula: it stays text.
    const stackedRows = new Set(group.map((item) => Math.round(item.line.y / 3))).size;
    if (stackedRows < 2 && rect.x1 - rect.x0 < bodySize * 8) continue;
    // Part of an inline fraction: a prose line runs through the same band.
    const inline = prose.some((line) => {
      const mid = line.y + line.size * 0.3;
      const hgap = Math.max(line.x - rect.x1, rect.x0 - line.end, 0);
      return (
        mid > rect.y0 + bodySize * 0.2 && mid < rect.y1 - bodySize * 0.2 && hgap <= bodySize * 2
      );
    });
    if (inline) continue;
    // No prose glyph may lie inside the band: delimiters raised above a
    // sentence ("pmatrix（ ( ）") are part of that sentence.
    const covers = prose.some((line) =>
      line.runs.some((run) => {
        const cx = run.x + run.width / 2;
        const cy = run.y + run.size * 0.3;
        return cx > rect.x0 && cx < rect.x1 && cy > rect.y0 && cy < rect.y1;
      }),
    );
    if (covers) continue;
    // Fraction bars and radical overlines drawn as rules inside the band.
    for (const seg of segments) {
      if (Math.abs(seg.y0 - seg.y1) > 0.5) continue;
      const x0 = Math.min(seg.x0, seg.x1);
      const x1 = Math.max(seg.x0, seg.x1);
      if (seg.y0 < rect.y0 - 2 || seg.y0 > rect.y1 + 2) continue;
      if (x1 < rect.x0 - 2 || x0 > rect.x1 + 2 || x1 - x0 > pageWidth * 0.6) continue;
      rect = { ...rect, x0: Math.min(rect.x0, x0), x1: Math.max(rect.x1, x1) };
    }
    const pad = bodySize * 0.25;
    regions.push({
      x0: Math.max(0, rect.x0 - pad),
      y0: Math.max(0, rect.y0 - pad),
      x1: Math.min(pageWidth, rect.x1 + pad),
      y1: Math.min(pageHeight, rect.y1 + pad),
      runs: members,
    });
  }
  return regions;
}
