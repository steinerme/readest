/**
 * Equation pictures are black glyphs on the page's white paper. Shown as-is
 * they are white boxes on dark or tinted reading themes. Here the bitmap is
 * turned into an ink mask: dark pixels become opaque, paper becomes clear,
 * and the reader paints the mask with the text colour, so an equation always
 * looks like the words around it, in every theme.
 */

/** Darkness (0 = paper, 1 = ink) below which a pixel is dropped entirely. It
 * removes faint page watermarks and scan noise behind the symbols. */
const FLOOR = 0.22;
/** Darkness at or above which a pixel is fully opaque. */
const CEIL = 0.72;

/**
 * Rewrite RGBA pixels in place into an alpha mask: colour becomes black and
 * alpha carries how much ink the pixel had. Anti-aliased edges keep partial
 * alpha so the glyphs stay smooth.
 */
export function inkMaskPixels(data: Uint8ClampedArray): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]! / 255;
    // Perceived lightness against white paper (transparent counts as paper).
    const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const dark = (1 - light) * a;
    const ink = Math.min(1, Math.max(0, (dark - FLOOR) / (CEIL - FLOOR)));
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = Math.round(ink * 255);
  }
}

/** Share of pixels that must be plain paper for a picture to count as line art. */
const LINE_ART_PAPER = 0.8;
/** Largest share of clearly coloured pixels a line-art picture may have. */
const LINE_ART_COLOUR = 0.01;

/**
 * Whether RGBA pixels are black-and-white line art on white paper: typeset
 * output boxes, framed sample tables, monochrome diagrams. Such pictures look
 * like a white sheet pasted on a dark page, so they are shown as an ink mask
 * too. Photos, colour charts and shaded figures keep their own pixels.
 */
export function isLineArt(data: Uint8ClampedArray): boolean {
  const count = Math.floor(data.length / 4);
  if (!count) return false;
  let paper = 0;
  let colour = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (data[i + 3]! < 128) {
      paper++;
      continue;
    }
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colour++;
    else if ((0.299 * r + 0.587 * g + 0.114 * b) / 255 >= 0.9) paper++;
  }
  return paper / count >= LINE_ART_PAPER && colour / count <= LINE_ART_COLOUR;
}

/** Load a rendered region and return a blob URL of its ink mask (PNG), or
 * null when the browser cannot read the pixels back. With `lineArtOnly`, a
 * picture that is not black-and-white line art also returns null, so the
 * caller keeps the original bitmap. */
export async function toInkMask(
  url: string,
  options: { lineArtOnly?: boolean } = {},
): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  let pixels: ImageData;
  try {
    pixels = context.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
  if (options.lineArtOnly && !isLineArt(pixels.data)) return null;
  inkMaskPixels(pixels.data);
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? URL.createObjectURL(blob) : null;
}
