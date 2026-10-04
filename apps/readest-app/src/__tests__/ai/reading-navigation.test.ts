import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  sessions: {} as Record<
    string,
    { navigate: ReturnType<typeof vi.fn>; revealCitation?: ReturnType<typeof vi.fn> }
  >,
  goTo: vi.fn(),
  view: null as null | { goTo: ReturnType<typeof vi.fn> },
}));
vi.mock('@/store/pdfReflowStore', () => ({
  usePdfReflowStore: { getState: () => ({ sessions: m.sessions }) },
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: { getState: () => ({ getView: () => m.view }) },
}));
import { goToCitation } from '@/services/ai/readingNavigation';

beforeEach(() => {
  vi.clearAllMocks();
  m.sessions = {};
  m.view = { goTo: m.goTo };
});
describe('citation navigation', () => {
  it('uses the reflow reveal service when present (projects onto the reflowed text)', async () => {
    const reveal = vi.fn();
    const navigate = vi.fn();
    m.sessions = { b: { navigate, revealCitation: reveal } };
    await goToCitation('b', 'cfi');
    expect(reveal).toHaveBeenCalledWith('cfi');
    expect(navigate).not.toHaveBeenCalled();
    expect(m.goTo).not.toHaveBeenCalled();
  });
  it('falls back to the reflow page navigation, then to the reader view', async () => {
    const navigate = vi.fn();
    m.sessions = { b: { navigate } };
    await goToCitation('b', 'cfi');
    expect(navigate).toHaveBeenCalledWith('cfi');
    m.sessions = {};
    await goToCitation('b', 'cfi2');
    expect(m.goTo).toHaveBeenCalledWith('cfi2');
  });
  it('does nothing harmful when no view exists', async () => {
    m.view = null;
    await expect(goToCitation('b', 'c')).resolves.toBeUndefined();
  });
  it('propagates a failure so the caller can tell the user', async () => {
    m.sessions = {
      b: { navigate: vi.fn(), revealCitation: vi.fn().mockRejectedValue(new Error('x')) },
    };
    await expect(goToCitation('b', 'c')).rejects.toThrow('x');
  });
});
