/**
 * Read-only extraction of the *geometry* that matters for reflow from a
 * pdf.js operator list: bitmap placements, axis-aligned rules (table lines)
 * and complex vector shapes (charts / diagrams). Nothing is rendered here.
 *
 * Coordinates are PDF user space relative to the page view origin (y up).
 * Every failure path degrades to "no graphics": reflow then behaves exactly
 * like the text-only mode.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RuleSegment {
  /** Horizontal rules have y0 === y1, vertical rules have x0 === x1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfGraphics {
  /** Bitmap placements (images, stencil masks). */
  images: Rect[];
  /** Axis-aligned strokes and thin filled rectangles. */
  segments: RuleSegment[];
  /** Bounding boxes of curved / diagonal / polygon paths. */
  shapes: Rect[];
  /** Filled axis-aligned boxes that are not thin rules (bars, cell shading). */
  fills: Rect[];
  /** pdf.js font id -> real font name (subset prefix removed), when known. */
  fonts?: Record<string, string>;
}

export interface PdfOperatorList {
  /** Optional font id -> name table supplied alongside the operator list. */
  fonts?: Record<string, string>;
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// pdf.js >= 5 path buffer opcodes (DrawOPS). Verified against pdfjs-dist 6.x.
const DRAW_MOVE = 0;
const DRAW_LINE = 1;
const DRAW_CURVE = 2;
const DRAW_QUAD = 3;
const DRAW_CLOSE = 4;

/** `new = m × ctm` (PDF row-vector convention). */
const multiply = (m: Matrix, ctm: Matrix): Matrix => [
  m[0] * ctm[0] + m[1] * ctm[2],
  m[0] * ctm[1] + m[1] * ctm[3],
  m[2] * ctm[0] + m[3] * ctm[2],
  m[2] * ctm[1] + m[3] * ctm[3],
  m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
  m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const finite = (values: ArrayLike<unknown>, count: number): boolean => {
  if (!values || values.length < count) return false;
  for (let i = 0; i < count; i++) if (!Number.isFinite(values[i] as number)) return false;
  return true;
};

const unitSquareBox = (m: Matrix): Rect => {
  const points = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/** True when the image's x axis is not (close to) a multiple of 90°. Page
 * watermarks are typically stamped at 30–45°; real figures are upright. */
const tilted = (m: Matrix): boolean => {
  if (Math.hypot(m[0], m[1]) < 1e-6) return false;
  const angle = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const off = Math.abs(((angle % 90) + 90) % 90);
  return Math.min(off, 90 - off) > 3;
};

const EDGE_EPS = 0.4;
const THIN_RULE = 2.6;

interface Subpath {
  points: Array<[number, number]>;
  closed: boolean;
  curved: boolean;
}

function decodePath(buffer: ArrayLike<number>, ctm: Matrix): Subpath[] {
  const result: Subpath[] = [];
  let current: Subpath | undefined;
  const start = () => {
    current = { points: [], closed: false, curved: false };
    result.push(current);
    return current;
  };
  for (let i = 0; i < buffer.length; ) {
    const op = buffer[i++]!;
    if (op === DRAW_MOVE) {
      const sub = start();
      sub.points.push(apply(ctm, buffer[i]!, buffer[i + 1]!));
      i += 2;
    } else if (op === DRAW_LINE) {
      const sub = current ?? start();
      sub.points.push(apply(ctm, buffer[i]!, buffer[i + 1]!));
      i += 2;
    } else if (op === DRAW_CURVE) {
      const sub = current ?? start();
      sub.curved = true;
      for (let k = 0; k < 6; k += 2)
        sub.points.push(apply(ctm, buffer[i + k]!, buffer[i + k + 1]!));
      i += 6;
    } else if (op === DRAW_QUAD) {
      const sub = current ?? start();
      sub.curved = true;
      for (let k = 0; k < 4; k += 2)
        sub.points.push(apply(ctm, buffer[i + k]!, buffer[i + k + 1]!));
      i += 4;
    } else if (op === DRAW_CLOSE) {
      if (current) current.closed = true;
    } else {
      // Unknown opcode: the buffer layout is not what we expect.
      return [];
    }
  }
  return result;
}

const bboxOf = (points: Array<[number, number]>): Rect => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
};

function classifyPath(
  subs: Subpath[],
  stroke: boolean,
  fill: boolean,
  out: { segments: RuleSegment[]; shapes: Rect[]; fills: Rect[] },
) {
  for (const sub of subs) {
    if (!sub.points.length) continue;
    if (sub.curved) {
      out.shapes.push(bboxOf(sub.points));
      continue;
    }
    const pts = sub.points;
    const closed =
      sub.closed || (pts.length >= 4 && dist(pts[0]!, pts[pts.length - 1]!) < EDGE_EPS);
    const edges: Array<[[number, number], [number, number]]> = [];
    for (let i = 0; i + 1 < pts.length; i++) edges.push([pts[i]!, pts[i + 1]!]);
    if (closed && pts.length >= 3) edges.push([pts[pts.length - 1]!, pts[0]!]);
    const axisAligned = edges.every(
      ([a, b]) => Math.abs(a[0] - b[0]) <= EDGE_EPS || Math.abs(a[1] - b[1]) <= EDGE_EPS,
    );
    const box = bboxOf(pts);
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    if (!axisAligned) {
      if (Math.max(w, h) >= 3) out.shapes.push(box);
      continue;
    }
    if (fill && !stroke && closed && pts.length >= 4) {
      // A filled rectangle: thin ones are rules drawn as boxes, wide ones are
      // cell shading / backgrounds and carry no structure for reflow.
      if (Math.min(w, h) <= THIN_RULE && Math.max(w, h) >= 6) {
        if (h <= w)
          out.segments.push({
            x0: box.x0,
            y0: (box.y0 + box.y1) / 2,
            x1: box.x1,
            y1: (box.y0 + box.y1) / 2,
          });
        else
          out.segments.push({
            x0: (box.x0 + box.x1) / 2,
            y0: box.y0,
            x1: (box.x0 + box.x1) / 2,
            y1: box.y1,
          });
      } else if (w >= 2 && h >= 2) out.fills.push(box);
      continue;
    }
    if (!stroke) continue;
    for (const [a, b] of edges) {
      if (Math.abs(a[1] - b[1]) <= EDGE_EPS && Math.abs(a[0] - b[0]) >= 0.5)
        out.segments.push({
          x0: Math.min(a[0], b[0]),
          y0: (a[1] + b[1]) / 2,
          x1: Math.max(a[0], b[0]),
          y1: (a[1] + b[1]) / 2,
        });
      else if (Math.abs(a[0] - b[0]) <= EDGE_EPS && Math.abs(a[1] - b[1]) >= 0.5)
        out.segments.push({
          x0: (a[0] + b[0]) / 2,
          y0: Math.min(a[1], b[1]),
          x1: (a[0] + b[0]) / 2,
          y1: Math.max(a[1], b[1]),
        });
    }
  }
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const shift = (rect: Rect, ox: number, oy: number): Rect => ({
  x0: rect.x0 - ox,
  y0: rect.y0 - oy,
  x1: rect.x1 - ox,
  y1: rect.y1 - oy,
});

const clampRect = (rect: Rect, width: number, height: number): Rect | null => {
  const clamped = {
    x0: Math.max(0, rect.x0),
    y0: Math.max(0, rect.y0),
    x1: Math.min(width, rect.x1),
    y1: Math.min(height, rect.y1),
  };
  return clamped.x1 - clamped.x0 > 0.5 && clamped.y1 - clamped.y0 > 0.5 ? clamped : null;
};

/**
 * @param ops   pdf.js `OPS` table (names → numbers), taken from the running
 *              library so operator numbers are never hard-coded.
 * @param origin page.view[0], page.view[1]
 */
export function extractPdfGraphics(
  list: PdfOperatorList,
  ops: Record<string, number>,
  origin: [number, number],
  pageWidth: number,
  pageHeight: number,
): PdfGraphics {
  const result: PdfGraphics = { images: [], segments: [], shapes: [], fills: [] };
  if (list.fonts) result.fonts = { ...list.fonts };
  try {
    const O = (name: string) => ops[name] ?? -1;
    const SAVE = O('save'),
      RESTORE = O('restore'),
      TRANSFORM = O('transform'),
      PATH = O('constructPath');
    const FORM_BEGIN = O('paintFormXObjectBegin'),
      FORM_END = O('paintFormXObjectEnd'),
      GROUP_BEGIN = O('beginGroup'),
      GROUP_END = O('endGroup');
    const IMAGE = new Set(
      ['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject'].map(O),
    );
    const IMAGE_REPEAT = O('paintImageXObjectRepeat'),
      MASK_REPEAT = O('paintImageMaskXObjectRepeat'),
      MASK_GROUP = O('paintImageMaskXObjectGroup'),
      INLINE_GROUP = O('paintInlineImageXObjectGroup');
    const STROKE_OPS = new Set(
      [
        'stroke',
        'closeStroke',
        'fillStroke',
        'eoFillStroke',
        'closeFillStroke',
        'closeEOFillStroke',
      ].map(O),
    );
    const FILL_OPS = new Set(
      ['fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'].map(
        O,
      ),
    );
    if (PATH < 0 || TRANSFORM < 0) return result;

    const rawSegments: RuleSegment[] = [];
    const rawShapes: Rect[] = [];
    const rawFills: Rect[] = [];
    const rawImages: Rect[] = [];
    const imageIds: Array<string | undefined> = [];
    const pushImage = (rect: Rect, id?: unknown, skewed = false) => {
      if (skewed) return;
      rawImages.push(rect);
      imageIds.push(typeof id === 'string' ? id : undefined);
    };
    let ctm: Matrix = IDENTITY;
    const stack: Matrix[] = [];
    const { fnArray, argsArray } = list;
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]!;
      const args = argsArray[i] as unknown[] | undefined;
      try {
        if (fn === SAVE || fn === GROUP_BEGIN) {
          stack.push(ctm);
        } else if (fn === RESTORE || fn === GROUP_END) {
          ctm = stack.pop() ?? IDENTITY;
        } else if (fn === TRANSFORM) {
          if (args && finite(args as number[], 6)) ctm = multiply(args as unknown as Matrix, ctm);
        } else if (fn === FORM_BEGIN) {
          stack.push(ctm);
          const matrix = args?.[0] as number[] | null | undefined;
          if (matrix && finite(matrix, 6)) ctm = multiply(matrix as unknown as Matrix, ctm);
        } else if (fn === FORM_END) {
          ctm = stack.pop() ?? IDENTITY;
        } else if (fn === PATH) {
          const op = args?.[0] as number;
          const stroke = STROKE_OPS.has(op);
          const fill = FILL_OPS.has(op);
          if (!stroke && !fill) continue;
          const buffer = (args?.[1] as ArrayLike<number>[] | undefined)?.[0];
          if (!buffer || typeof buffer.length !== 'number') continue;
          classifyPath(decodePath(buffer, ctm), stroke, fill, {
            segments: rawSegments,
            shapes: rawShapes,
            fills: rawFills,
          });
        } else if (IMAGE.has(fn)) {
          pushImage(unitSquareBox(ctm), args?.[0], tilted(ctm));
        } else if (fn === IMAGE_REPEAT) {
          // [objId, scaleX, scaleY, positions]
          const [, sx, sy, positions] = args as [unknown, number, number, ArrayLike<number>];
          for (let k = 0; k + 1 < positions.length; k += 2)
            rawImages.push(
              unitSquareBox(multiply([sx, 0, 0, sy, positions[k]!, positions[k + 1]!], ctm)),
            );
        } else if (fn === MASK_REPEAT) {
          // [img, scaleX, skewX, skewY, scaleY, positions]
          const [, sx, kx, ky, sy, positions] = args as [
            unknown,
            number,
            number,
            number,
            number,
            ArrayLike<number>,
          ];
          for (let k = 0; k + 1 < positions.length; k += 2)
            rawImages.push(
              unitSquareBox(multiply([sx, kx, ky, sy, positions[k]!, positions[k + 1]!], ctm)),
            );
        } else if (fn === MASK_GROUP) {
          for (const image of (args?.[0] as Array<{ transform?: number[] }>) ?? [])
            if (image.transform && finite(image.transform, 6))
              rawImages.push(unitSquareBox(multiply(image.transform as unknown as Matrix, ctm)));
        } else if (fn === INLINE_GROUP) {
          for (const entry of (args?.[1] as Array<{ transform?: number[] }>) ?? [])
            if (entry.transform && finite(entry.transform, 6))
              rawImages.push(unitSquareBox(multiply(entry.transform as unknown as Matrix, ctm)));
        }
      } catch {
        // One malformed operator must not discard the page.
      }
    }
    const [ox, oy] = origin;
    // The same bitmap stamped four or more times is a tiled watermark or
    // texture, never a figure.
    const uses = new Map<string, number>();
    for (const id of imageIds) if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
    rawImages.forEach((image, index) => {
      const id = imageIds[index];
      if (id && (uses.get(id) ?? 0) >= 4) return;
      const rect = clampRect(shift(image, ox, oy), pageWidth, pageHeight);
      if (rect) result.images.push(rect);
    });
    for (const shape of rawShapes) {
      const rect = clampRect(shift(shape, ox, oy), pageWidth, pageHeight);
      if (rect) result.shapes.push(rect);
    }
    for (const fill of rawFills) {
      const rect = clampRect(shift(fill, ox, oy), pageWidth, pageHeight);
      if (rect) result.fills.push(rect);
    }
    for (const seg of rawSegments) {
      const s = shift(seg, ox, oy);
      if (s.x1 < 0 || s.x0 > pageWidth || s.y1 < 0 || s.y0 > pageHeight) continue;
      result.segments.push(s);
    }
  } catch {
    return { images: [], segments: [], shapes: [], fills: [], fonts: result.fonts };
  }
  return result;
}
