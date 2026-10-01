import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DocumentLoader, type BookDoc } from '@/libs/document';
import { reflowPdfText, normalizePdfSpeechText } from '@/utils/pdfReflow';
import { mapPdfSpeechRange } from '@/utils/pdfReflowTTS';
import { TTS } from 'foliate-js/tts.js';
import { textWalker } from 'foliate-js/text-walker.js';

let book: BookDoc;
beforeAll(async () => {
  await import('@pdfjs/pdf.min.mjs');
  const lib = (
    globalThis as unknown as { pdfjsLib: { GlobalWorkerOptions: { workerSrc: string } } }
  ).pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = new URL(
    `file://${join(process.cwd(), 'public/vendor/pdfjs/pdf.worker.min.mjs')}`,
  ).href;
  const file = new File(
    [readFileSync(resolve(__dirname, '../fixtures/data/sample-alice.pdf'))],
    'sample.pdf',
    { type: 'application/pdf' },
  );
  book = (await new DocumentLoader(file).open()).book;
}, 30000);

describe('real PDF reflow speech provenance', () => {
  it('maps actual PDF text-layer ranges on three pages without repeated-text search', async () => {
    for (let page = 0; page < Math.min(3, book.sections.length); page++) {
      const section = book.sections[page]!;
      const data = await section.getReflowText!();
      const reflow = reflowPdfText(data.items, data.width, data.height, true);
      const doc = await section.createDocument();
      const layer = doc.querySelector('.textLayer')!;
      expect(normalizePdfSpeechText(layer.textContent ?? '')).toBe(reflow.sourceText);
      const range = doc.createRange();
      range.selectNodeContents(layer);
      const marks = mapPdfSpeechRange(reflow, range);
      expect(marks.length).toBeGreaterThan(0);
      const marked = marks.map((m) => reflow.blocks[m.block]!.text.slice(m.start, m.end)).join('');
      expect(normalizePdfSpeechText(marked)).toBe(
        normalizePdfSpeechText(reflow.blocks.map((b) => b.text).join('')),
      );
    }
  });
  it('maps real foliate sentence marks into displayed reflow paragraphs', async () => {
    const section = book.sections[0]!;
    const data = await section.getReflowText!();
    const reflow = reflowPdfText(data.items, data.width, data.height, true);
    const doc = await section.createDocument();
    const tts = new TTS(doc, textWalker, undefined, () => {}, 'sentence');
    expect(tts.start()).toBeTruthy();
    const range = tts.setMark('0');
    expect(range).toBeTruthy();
    expect(mapPdfSpeechRange(reflow, range!).length).toBeGreaterThan(0);
  });
});
