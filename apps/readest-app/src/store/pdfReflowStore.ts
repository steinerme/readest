import { create } from 'zustand';

/** A rendering mode in the existing reader, not a second reader/session. */
export interface PdfReflowSession {
  page: number;
  count: number;
  navigate: (target: number | string) => Promise<void>;
  revealCitation?: (cfi: string) => Promise<void>;
  close: () => void;
  speak: () => Promise<void>;
  returnToSpeech: () => void;
}
interface State {
  sessions: Record<string, PdfReflowSession>;
  setSession: (key: string, session: PdfReflowSession) => void;
  clearSession: (key: string, navigate: PdfReflowSession['navigate']) => void;
}
export const usePdfReflowStore = create<State>((set) => ({
  sessions: {},
  setSession: (key, session) => set((s) => ({ sessions: { ...s.sessions, [key]: session } })),
  clearSession: (key, navigate) =>
    set((s) => {
      if (s.sessions[key]?.navigate !== navigate) return s;
      const sessions = { ...s.sessions };
      delete sessions[key];
      return { sessions };
    }),
}));
