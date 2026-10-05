/** Run/line construction shared by flow text, table cells and layout analysis.
 * Coordinates are unmodified PDF coordinates (larger baseline y is higher). */

export type Run = {
  text: string;
  source: number[];
  x: number;
  y: number;
  size: number;
  width: number;
  rotated: boolean;
  /** Set only for text tilted off the 0/90/180/270 axes (typical watermark). */
  diagonal?: boolean;
};

export type Line = {
  runs: Run[];
  y: number;
  size: number;
  x: number;
  end: number;
  text: string;
  source: number[];
  /** A large mid-page gap suggests this row crosses columns. */
  wideGap?: boolean;
};

export function joinMapped(
  left: { text: string; source: number[] },
  right: { text: string; source: number[] },
  space: boolean,
  wrapped = false,
) {
  const text = joinText(left.text, right.text, space, wrapped);
  const b = right.text.trimStart().trimEnd();
  // joinText preserves the right's trailing whitespace only after a nonempty left.
  const rightText = left.text ? right.text.trimStart() : b;
  const prefix = text.length - rightText.length;
  const source = left.source.slice(0, Math.min(prefix, left.text.trimEnd().length));
  while (source.length < prefix) source.push(-1);
  const rightStart = right.text.length - right.text.trimStart().length;
  source.push(...right.source.slice(rightStart, rightStart + rightText.length));
  return { text, source };
}

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const closing = /^[,.;:!?，。；：！？、）】》」』〉〕］｝％%…]/u;
const opening = /[(（【《「『〈〔［｛]$/u;

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function textSize(runs: Run[]): number {
  const sorted = [...runs].sort((a, b) => a.size - b.size);
  const total = sorted.reduce((n, run) => n + Math.max(1, run.text.trim().length), 0);
  let weight = 0;
  for (const run of sorted) {
    weight += Math.max(1, run.text.trim().length);
    if (weight >= total / 2) return run.size;
  }
  return 1;
}

// Geometry decides word spacing inside a line. Across wrapped lines, Latin
// words need a space; CJK and punctuation do not. Only discretionary soft
// hyphens are removed: a visible hyphen may be part of a compound or identifier.
export function joinText(left: string, right: string, space: boolean, wrapped = false): string {
  if (!left) return right.trim();
  if (!right.trim()) return left;
  const a = left.trimEnd();
  const b = right.trimStart();
  if (wrapped && a.endsWith('\u00ad')) return a.slice(0, -1) + b;
  if (wrapped && /[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a + b;
  const last = Array.from(a).pop() || '';
  const first = Array.from(b)[0] || '';
  if (cjk.test(last) || cjk.test(first) || closing.test(b) || opening.test(a)) return a + b;
  return a + (space ? ' ' : '') + b;
}

/** Group runs into baselines and join each baseline left-to-right.
 * `wideGapRows` counts rows with a large mid-page gap (possible columns). */
export function buildLines(runs: Run[], pageWidth: number): { lines: Line[]; wideGapRows: number } {
  // Seed lines with large glyphs first so a superscript cannot pull the body
  // baseline upward. Font-scaled tolerance avoids fixed-point assumptions.
  const lines: Line[] = [];
  for (const run of [...runs].sort((a, b) => b.size - a.size || b.y - a.y || a.x - b.x)) {
    let best: Line | undefined;
    let bestDistance = Infinity;
    for (const line of lines) {
      if (run.rotated || line.runs[0]!.rotated) continue;
      const distance = Math.abs(run.y - line.y);
      const small = run.size < line.size * 0.8;
      const tolerance = line.size * (small ? 0.65 : 0.28);
      // Small raised/lowered glyphs must also be horizontally near this line.
      const horizontalGap = Math.max(line.x - (run.x + run.width), run.x - line.end, 0);
      if (
        distance <= tolerance &&
        (!small || distance <= line.size * 0.28 || horizontalGap <= line.size * 1.5) &&
        distance < bestDistance
      ) {
        best = line;
        bestDistance = distance;
      }
    }
    if (best) {
      best.runs.push(run);
      best.x = Math.min(best.x, run.x);
      best.end = Math.max(best.end, run.x + run.width);
    } else {
      lines.push({
        runs: [run],
        y: run.y,
        size: run.size,
        x: run.x,
        end: run.x + run.width,
        text: '',
        source: [],
      });
    }
  }
  lines.sort((a, b) => b.y - a.y || a.x - b.x);
  let wideGapRows = 0;
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    line.size = textSize(line.runs);
    let previous: Run | undefined;
    let wideGap = false;
    for (const run of line.runs) {
      const gap = previous ? run.x - (previous.x + previous.width) : 0;
      if (
        previous &&
        pageWidth > 0 &&
        gap > Math.max(pageWidth * 0.12, line.size * 4) &&
        previous.x + previous.width < pageWidth * 0.65 &&
        run.x > pageWidth * 0.35
      )
        wideGap = true;
      const explicitSpace = !!previous && (/\s$/.test(previous.text) || /^\s/.test(run.text));
      const superscript =
        !!previous &&
        Math.min(previous.size, run.size) < Math.max(previous.size, run.size) * 0.8 &&
        Math.abs(previous.y - run.y) > line.size * 0.15;
      const joined = joinMapped(
        line,
        run,
        !superscript && (explicitSpace || gap > line.size * 0.12),
      );
      line.text = joined.text;
      line.source = joined.source;
      previous = run;
    }
    line.wideGap = wideGap;
    if (wideGap) wideGapRows++;
  }
  return { lines, wideGapRows };
}

/** Join top-to-bottom lines (e.g. the lines inside one table cell) into one text. */
export function joinLines(lines: Line[]): { text: string; source: number[] } {
  let acc = { text: '', source: [] as number[] };
  for (const line of lines) acc = joinMapped(acc, line, true, true);
  return acc;
}
