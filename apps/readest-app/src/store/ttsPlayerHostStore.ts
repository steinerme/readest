import { create } from 'zustand';

/** Visual host only: the reader's TTSControl remains the sole session owner.
 * A reflow overlay borrows its existing player rather than starting a controller. */
interface TTSPlayerHostState {
  hosts: Record<string, HTMLElement>;
  setHost: (bookKey: string, host: HTMLElement) => void;
  clearHost: (bookKey: string, host: HTMLElement) => void;
}

export const useTTSPlayerHostStore = create<TTSPlayerHostState>((set) => ({
  hosts: {},
  setHost: (bookKey, host) => set((state) => ({ hosts: { ...state.hosts, [bookKey]: host } })),
  clearHost: (bookKey, host) =>
    set((state) => {
      // A late cleanup must not remove a newer reader's host for the same book.
      if (state.hosts[bookKey] !== host) return state;
      const hosts = { ...state.hosts };
      delete hosts[bookKey];
      return { hosts };
    }),
}));
