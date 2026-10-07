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
  /** Font family class when the font name is known (see fontClass). */
  font?: FontClass;
  /** Real font name (subset prefix removed), when known. */
  fontName?: string;
};

/** `mono`: typewriter/code fonts. `math`: TeX math italic, symbol and extension
 * fonts whose glyphs are formula pieces. `bold`: bold text fonts. */
export type FontClass = 'mono' | 'math' | 'bold';

const MONO_FONT =
  /(typewriter|courier|consol|menlo|monaco|mono(?!type)|^cmtt|sftt|lmmono|inconsolata|source ?code|fira ?code|nimbusmon|^nsimsun)/i;
// TeX math fonts: math italic (cmmi), symbols (cmsy, msam, msbm), extension
// (cmex, yhcmex, txex), and their tx/px equivalents. Text roman fonts (cmr) are
// used for digits in formulas but also for prose, so they are not included.
const MATH_FONT =
  /^(cmmi|cmbsy|cmsy|cmex|msam|msbm|yhcmex|txex|txsy|rtxmi|pxsy|pxex|pxmi|eufm|eusm|stix.*math|cambria ?math|symbolmt$|symbol$)/i;
const BOLD_FONT = /(bold|black|heavy|semibold|demi|-medi\b|medium|^cmbx|-bd\b)/i;

export function fontClass(name: string | undefined): FontClass | undefined {
  if (!name) return undefined;
  const clean = name.replace(/^[A-Z]{6}\+/, '');
  if (MONO_FONT.test(clean)) return 'mono';
  if (MATH_FONT.test(clean)) return 'math';
  if (BOLD_FONT.test(clean)) return 'bold';
  return undefined;
}

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
  // A line-end hyphen after a word fragment and before a lower-case fragment
  // is the typesetter's: "representa-" + "tion" -> "representation". A hyphen
  // after a complete word part ("well-" + "known", "pre-" + "trained") is kept:
  // fragments of one or two letters before it, or a known prefix, stay joined
  // with the hyphen.
  if (wrapped && /[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) {
    const stem = /([A-Za-z]+)-$/.exec(a)?.[1] ?? '';
    const keep =
      /^(well|self|non|pre|post|re|co|anti|multi|cross|semi|sub|super|inter|intra|over|under|fine|task|end|state|large|small|high|low|long|short|real|single|two|three|four|five|left|right|top|bottom|full|half|open|closed|deep|feature|sentence|token|word|data|model|zero|few|one)$/i.test(
        stem,
      );
    return keep ? a + b : a.slice(0, -1) + b;
  }
  const last = Array.from(a).pop() || '';
  const first = Array.from(b)[0] || '';
  if (cjk.test(last) || cjk.test(first) || closing.test(b) || opening.test(a)) return a + b;
  return a + (space ? ' ' : '') + b;
}

/** Join one baseline's runs (already sorted left to right) into text. Geometry
 * decides spacing; raised or lowered small runs attach without a space. */
const SUPER: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
};
const SUB: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
};
const SCRIPT_TEXT = /^[0-9+\-−=()]+$/u;

/**
 * A small run of digits raised above (or dropped below) the line, right after
 * a glyph, is an exponent or index: "10" + "20" is 10²⁰, "m" + "−1" is m⁻¹,
 * "M" + "2" is M₂. Shown flat they read as different numbers (1020, m−1), so
 * they become Unicode super/subscript characters. One display character per
 * source character keeps the source map aligned.
 */
function scriptRun(run: Run, previous: Run | undefined, baseline: number, size: number): Run {
  if (!previous || run.size >= size * 0.85) return run;
  const text = run.text.trim();
  if (!text || !SCRIPT_TEXT.test(text) || text.length > 4) return run;
  if (run.x - (previous.x + previous.width) > size * 0.25) return run;
  const lift = run.y - baseline;
  const table = lift > size * 0.2 ? SUPER : lift < -size * 0.08 ? SUB : null;
  if (!table) return run;
  const mapped = Array.from(run.text, (ch) => table[ch] ?? ch).join('');
  return mapped.length === run.text.length ? { ...run, text: mapped } : run;
}

export function joinLineRuns(runs: Run[], size: number): { text: string; source: number[] } {
  let acc = { text: '', source: [] as number[] };
  let previous: Run | undefined;
  const full = runs.filter((run) => run.size >= size * 0.9);
  const baseline = median(full.length ? full.map((run) => run.y) : runs.map((run) => run.y));
  for (const raw of runs) {
    const run = scriptRun(raw, previous, baseline, size);
    const gap = previous ? run.x - (previous.x + previous.width) : 0;
    const explicitSpace = !!previous && (/\s$/.test(previous.text) || /^\s/.test(run.text));
    const superscript =
      !!previous &&
      Math.min(previous.size, run.size) < Math.max(previous.size, run.size) * 0.8 &&
      Math.abs(previous.y - run.y) > size * 0.15;
    // After a raised/lowered script, a gap wider than a thin space is a word
    // space ("kg m² s⁻²"); before a script, never.
    const afterScript = superscript && !!previous && previous.size < run.size;
    acc = joinMapped(
      acc,
      run,
      superscript
        ? afterScript && (explicitSpace || gap > size * 0.18)
        : explicitSpace || gap > size * 0.12,
    );
    previous = run;
  }
  return acc;
}

/** Group runs into baselines and join each baseline left-to-right.
 * `wideGapRows` counts rows with a large mid-page gap (possible columns). */
export function buildLines(
  runs: Run[],
  pageWidth: number,
  /** Runs in different regions never share a line. */
  regionOf?: Map<Run, number>,
): { lines: Line[]; wideGapRows: number } {
  // Seed lines with large glyphs first so a superscript cannot pull the body
  // baseline upward. Font-scaled tolerance avoids fixed-point assumptions.
  const lines: Line[] = [];
  for (const run of [...runs].sort((a, b) => b.size - a.size || b.y - a.y || a.x - b.x)) {
    let best: Line | undefined;
    let bestDistance = Infinity;
    for (const line of lines) {
      if (run.rotated || line.runs[0]!.rotated) continue;
      if (regionOf && regionOf.get(run) !== regionOf.get(line.runs[0]!)) continue;
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
  // A lone delimiter from a TeX extension font ("（ ( ）" in prose) has a raised
  // baseline of its own. When it sits between two glyphs of the line just
  // below, it belongs to that line.
  const delimiter = (run: Run) =>
    /^(cmex|yhcmex|txex|pxex)/i.test(run.fontName ?? '') && run.text.trim().length <= 2;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.runs.every(delimiter)) continue;
    const moved = new Set<Run>();
    for (const run of line.runs) {
      const host = lines.find(
        (other) =>
          other !== line &&
          !other.runs.every(delimiter) &&
          run.y >= other.y &&
          run.y - other.y <= other.size * 1.0 &&
          (!regionOf || regionOf.get(run) === regionOf.get(other.runs[0]!)) &&
          other.runs.some(
            (o) => o.x + o.width <= run.x + 1 && run.x - (o.x + o.width) < other.size,
          ) &&
          other.runs.some(
            (o) => o.x >= run.x + run.width - 1 && o.x - (run.x + run.width) < other.size,
          ),
      );
      if (!host) continue;
      // A tall bar drawn as two stacked pieces of the same glyph is one bar.
      const twin = host.runs.find(
        (o) => delimiter(o) && o.text === run.text && Math.abs(o.x - run.x) < 1,
      );
      if (twin) {
        moved.add(run);
        continue;
      }
      host.runs.push(run);
      host.x = Math.min(host.x, run.x);
      host.end = Math.max(host.end, run.x + run.width);
      moved.add(run);
    }
    line.runs = line.runs.filter((run) => !moved.has(run));
    if (!line.runs.length) lines.splice(i, 1);
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
      previous = run;
    }
    const joined = joinLineRuns(line.runs, line.size);
    line.text = joined.text;
    line.source = joined.source;
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
