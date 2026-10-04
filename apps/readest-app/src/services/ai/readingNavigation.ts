import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { useReaderStore } from '@/store/readerStore';

/** Jump to a source location through the same services the reader itself uses. */
export async function goToCitation(bookKey: string, cfi: string): Promise<void> {
  const reflow = usePdfReflowStore.getState().sessions[bookKey];
  if (reflow?.revealCitation) await reflow.revealCitation(cfi);
  else if (reflow) await reflow.navigate(cfi);
  else await useReaderStore.getState().getView(bookKey)?.goTo(cfi);
}
