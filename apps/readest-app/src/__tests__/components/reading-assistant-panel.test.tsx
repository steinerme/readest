import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  settings: {
    aiSettings: {
      enabled: true,
      provider: 'openrouter',
      openrouterBaseUrl: 'https://example.com/v1',
    },
  },
  collect: vi.fn(),
  answer: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  speech: vi.fn(),
  warm: vi.fn(),
  saveConfig: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
  goto: vi.fn(),
  close: vi.fn(),
  controller: { state: 'playing' },
  settingsPanel: vi.fn(),
  settingsOpen: vi.fn(),
}));
vi.mock('@/components/ModalPortal', () => ({
  default: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/Dialog', () => ({
  default: ({
    children,
    onClose,
  }: {
    children: import('react').ReactNode;
    onClose: () => void;
  }) => (
    <div>
      <button onClick={onClose}>关闭助手</button>
      {children}
    </div>
  ),
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/store/settingsStore', () => {
  const state = {
    get settings() {
      return m.settings;
    },
    setSettingsDialogBookKey: vi.fn(),
    setRequestedPanel: m.settingsPanel,
    setSettingsDialogOpen: m.settingsOpen,
  };
  return {
    useSettingsStore: Object.assign((s: (value: typeof state) => unknown) => s(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/store/bookDataStore', () => {
  const state = {
    getBookData: () => ({
      book: { title: '测试书', hash: 'hash', format: 'PDF' },
      bookDoc: { sections: [1, 2] },
    }),
    getConfig: () => ({ booknotes: [] }),
    updateBooknotes: m.update,
    saveConfig: m.saveConfig,
  };
  return {
    useBookDataStore: Object.assign((s: (value: typeof state) => unknown) => s(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/store/readerStore', () => ({
  useReaderStore: {
    getState: () => ({
      getView: () => ({ renderer: { index: 0 }, goTo: m.goto, lastLocation: { cfi: 'boundary' } }),
    }),
  },
}));
vi.mock('@/store/pdfReflowStore', () => ({
  usePdfReflowStore: {
    getState: () => ({ sessions: { 'hash-view': { page: 0, navigate: m.navigate } } }),
  },
}));
vi.mock('@/services/ai/readingContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ai/readingContext')>()),
  collectReadingContext: m.collect,
}));
vi.mock('@/services/ai/readingAssistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ai/readingAssistant')>()),
  streamReadingAnswer: m.answer,
}));
vi.mock('@/services/ai/readingSpeech', () => ({
  pauseReading: m.pause,
  resumeReading: m.resume,
  readingController: () => m.controller,
  speakReadingAnswer: m.speech,
  warmReadingSpeech: m.warm,
}));
import ReadingAssistantPanel from '@/app/reader/components/ai/ReadingAssistantPanel';
const passage = { id: 's0p0', text: '真实原文', cfi: 'real', sectionIndex: 0, label: '物理页 1' };
const context = { passages: [passage], scanned: 1, total: 1, warnings: [] };
const request = {
  bookKey: 'hash-view',
  mode: 'selection' as const,
  seed: { text: '真实原文', cfi: 'real', sectionIndex: 0 },
  seeds: [],
};
const prepare = async () => {
  fireEvent.click(screen.getByText('准备原文 · 本地检索'));
  await screen.findByText('确认发送给 AI');
};
const send = async () => {
  await prepare();
  fireEvent.click(screen.getByText('确认发送给 AI'));
  await screen.findByText('AI 解读 · 请结合原文判断');
};
beforeEach(() => {
  vi.clearAllMocks();
  m.settings.aiSettings.enabled = true;
  m.controller.state = 'playing';
  m.collect.mockResolvedValue(context);
  m.update.mockReturnValue({ booknotes: [] });
  m.saveConfig.mockResolvedValue(undefined);
  m.pause.mockImplementation(async () => {
    m.controller.state = 'paused';
    return true;
  });
  m.resume.mockResolvedValue(true);
  m.speech.mockResolvedValue(undefined);
  m.answer.mockImplementation(async (options) => {
    const text = '作者观点 [s0p0]';
    options.onText(text);
    return text;
  });
});
afterEach(cleanup);
describe('reading assistant shared panel', () => {
  it('does not send on opening or selecting an action, and requires preview confirmation', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    expect(m.answer).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('举个例子'));
    expect(m.answer).not.toHaveBeenCalled();
    await prepare();
    expect(m.answer).not.toHaveBeenCalled();
    expect(screen.getByLabelText('外发内容预览').textContent).toContain('https://example.com/v1');
    fireEvent.click(screen.getByText('确认发送给 AI'));
    await screen.findByText('作者观点 [s0p0]');
    expect(m.answer).toHaveBeenCalledTimes(1);
  });
  it('invalidates preview when the question or scope changes', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await prepare();
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '新问题' } });
    expect(screen.queryByText('确认发送给 AI')).toBeNull();
    expect(m.answer).not.toHaveBeenCalled();
    await prepare();
    fireEvent.change(screen.getByLabelText('内容范围'), { target: { value: 'all' } });
    expect(screen.queryByText('确认发送给 AI')).toBeNull();
  });
  it('jumps using the original reflow navigation service', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    fireEvent.click(screen.getByText('[s0p0] 物理页 1 · 回到原文'));
    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('real'));
    expect(m.goto).not.toHaveBeenCalled();
    expect(m.close).toHaveBeenCalled();
  });
  it('does not expose a fabricated citation as a clickable source', async () => {
    m.answer.mockImplementation(async (o) => {
      const text = '假引用 [s999p0]';
      o.onText(text);
      return text;
    });
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    expect(screen.queryByText(/回到原文/)).toBeNull();
    expect(screen.getByText(/答案未提供可识别/)).toBeTruthy();
  });
  it('saves AI content with an explicit AI label and original CFI', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    fireEvent.click(screen.getByText('保存 AI 解读为笔记'));
    await screen.findByText('已保存到书籍笔记');
    const note = m.update.mock.calls[0]![1][0];
    expect(note.cfi).toBe('real');
    expect(note.text).toBe('真实原文');
    expect(note.note).toContain('【AI 解读，仅供参考】');
    expect(note.note).toContain('作者观点');
    expect(m.saveConfig).toHaveBeenCalledTimes(1);
  });
  it('pauses listening without changing the original reading position', async () => {
    render(
      <ReadingAssistantPanel
        request={{ ...request, mode: 'listening', seeds: [request.seed] }}
        onClose={m.close}
      />,
    );
    await prepare();
    expect(m.pause).toHaveBeenCalledWith('hash-view');
    expect(m.navigate).not.toHaveBeenCalled();
    expect(m.goto).not.toHaveBeenCalled();
    expect(m.collect.mock.calls[0]![0].scope).toBe('listening');
  });
  it('records just-heard original text without an AI request', async () => {
    render(
      <ReadingAssistantPanel
        request={{ ...request, mode: 'listening', seeds: [request.seed] }}
        onClose={m.close}
      />,
    );
    fireEvent.click(screen.getByText('把刚才的原文记下来'));
    await waitFor(() => expect(m.saveConfig).toHaveBeenCalled());
    expect(m.update.mock.calls[0]![1][0].note).toBe('【听书记录 · 原文】');
    expect(m.answer).not.toHaveBeenCalled();
  });
  it('requires separate voice consent, then pauses, speaks and resumes same controller', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    const button = screen.getByText('朗读解释，然后继续原文');
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByText(/允许将本条 AI 回答/));
    fireEvent.click(button);
    await waitFor(() => expect(m.resume).toHaveBeenCalledWith('hash-view', m.controller));
    expect(m.speech).toHaveBeenCalledTimes(1);
    expect(m.pause).toHaveBeenCalledTimes(1);
  });
  it('leaves original paused if explanation speech fails', async () => {
    m.speech.mockRejectedValue(new Error('VOICE_FAILED'));
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    fireEvent.click(screen.getByText(/允许将本条 AI 回答/));
    fireEvent.click(screen.getByText('朗读解释，然后继续原文'));
    await screen.findByRole('alert');
    expect(m.resume).not.toHaveBeenCalled();
  });
  it('cancelled or closed requests never auto resume or save partial answers', async () => {
    let signal: AbortSignal | null = null;
    m.answer.mockImplementation((o) => {
      signal = o.signal;
      return new Promise(() => {});
    });
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await prepare();
    fireEvent.click(screen.getByText('确认发送给 AI'));
    fireEvent.click(screen.getByText('关闭助手'));
    expect(signal!.aborted).toBe(true);
    expect(m.resume).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });
  it('does not carry all-book history back into protected read scope', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('内容范围'), { target: { value: 'all' } });
    await send();
    fireEvent.change(screen.getByLabelText('内容范围'), { target: { value: 'read' } });
    await send();
    expect(m.answer.mock.calls[1]![0].history).toEqual([]);
  });
  it('supports followup questions within the same range and previews history', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '为什么？' } });
    await prepare();
    expect(screen.getByText('此次还会发送最近同范围的问答，供继续追问')).toBeTruthy();
    fireEvent.click(screen.getByText('确认发送给 AI'));
    await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(2));
    expect(m.answer.mock.calls[1]![0].history).toHaveLength(2);
  });
  it('opens existing AI settings and never leaks backend exception bodies', async () => {
    m.answer.mockRejectedValue(new Error('Authorization Bearer SECRET'));
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await prepare();
    fireEvent.click(screen.getByText('确认发送给 AI'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('SECRET');
    fireEvent.click(screen.getByText('AI 设置'));
    expect(m.settingsPanel).toHaveBeenCalledWith('AI');
    expect(m.settingsOpen).toHaveBeenCalledWith(true);
  });
  it('disabled AI still allows local preview but blocks sending', async () => {
    m.settings.aiSettings.enabled = false;
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await prepare();
    expect(screen.getByText('确认发送给 AI')).toHaveProperty('disabled', true);
    expect(m.answer).not.toHaveBeenCalled();
  });
});
