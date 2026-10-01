export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  dir?: string;
}

export interface ReflowBlock {
  kind: 'paragraph' | 'note';
  text: string;
}

export interface ReflowPage {
  blocks: ReflowBlock[];
  removedPageNumbers: string[];
  warnings: string[];
  /** Optional local-only provenance: normalized PDF item stream and, per block,
   * the source character offset for every displayed UTF-16 character (-1 = spacing). */
  sourceText?: string;
  sourceMap?: number[][];
}

type Run = {
  text: string;
  source: number[];
  x: number;
  y: number;
  size: number;
  width: number;
  rotated: boolean;
};
type Line = {
  runs: Run[];
  y: number;
  size: number;
  x: number;
  end: number;
  text: string;
  source: number[];
};

export const normalizePdfSpeechText = (text: string) =>
  text.normalize('NFKC').replace(/[\s\u00ad]/gu, '');

function joinMapped(
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

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function textSize(runs: Run[]): number {
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
function joinText(left: string, right: string, space: boolean, wrapped = false): string {
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

/**
 * Conservative, dependency-free reflow for single-column horizontal pages.
 * Coordinates are unmodified PDF coordinates (larger baseline y is higher).
 * Warnings are stable codes: empty-text, rotated-text,
 * possible-multiple-columns, invalid-text-item. Suspected columns are retained
 * in visual row order, not silently discarded or claimed to be fully reflowed.
 */
export function reflowPdfText(
  items: PdfTextItem[],
  pageWidth: number,
  pageHeight: number,
  withSourceMap = false,
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
  const runs: Run[] = [];
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
    runs.push({
      text,
      source,
      x: x!,
      y: y!,
      size,
      width: Math.abs(item.width),
      rotated,
    });
  }
  if (!runs.length) {
    warn('empty-text');
    return result;
  }

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
    if (wideGap) wideGapRows++;
  }
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
  if (!kept.length) return result;
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
  let previous: Line | undefined;
  for (const line of kept) {
    const kind: ReflowBlock['kind'] = line.size < bodySize * 0.85 ? 'note' : 'paragraph';
    const last = result.blocks[result.blocks.length - 1];
    const gap = previous ? previous.y - line.y : Infinity;
    const sizeChange =
      previous && Math.max(previous.size, line.size) / Math.min(previous.size, line.size) > 1.18;
    const indented =
      previous &&
      line.x - leftMargin > line.size * 1.2 &&
      previous.x - leftMargin <= line.size * 0.7;
    const rotated =
      line.runs.some((run) => run.rotated) || previous?.runs.some((run) => run.rotated);
    const limit = kind === 'note' ? line.size * 1.8 : Math.max(leading * 1.45, bodySize * 1.65);
    if (
      !last ||
      last.kind !== kind ||
      gap > limit ||
      sizeChange ||
      indented ||
      columns ||
      rotated
    ) {
      result.blocks.push({ kind, text: line.text });
      blockSources.push(line.source);
    } else {
      const joined = joinMapped(
        { text: last.text, source: blockSources[blockSources.length - 1]! },
        line,
        true,
        true,
      );
      last.text = joined.text;
      blockSources[blockSources.length - 1] = joined.source;
    }
    previous = line;
  }
  return result;
}
