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
  expand: vi.fn(),
  goCite: vi.fn(),
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
  expandQueryTerms: m.expand,
}));
vi.mock('@/services/ai/readingNavigation', () => ({ goToCitation: m.goCite }));
vi.mock('@/services/ai/readingSpeech', () => ({
  pauseReading: m.pause,
  resumeReading: m.resume,
  readingController: () => m.controller,
  speakReadingAnswer: m.speech,
  warmReadingSpeech: m.warm,
}));
import ReadingAssistantPanel, {
  FOLLOWUP_CHAR_BUDGET,
} from '@/app/reader/components/ai/ReadingAssistantPanel';
import { clearAllConsent } from '@/services/ai/readingConsent';
import { loadHistory } from '@/services/ai/readingHistory';
import { RECAP_QUESTION } from '@/services/ai/readingContext';
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
  localStorage.clear();
  clearAllConsent();
  m.expand.mockResolvedValue([]);
  m.goCite.mockResolvedValue(undefined);
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
  it('jumps through the shared navigation service and closes', async () => {
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    fireEvent.click(screen.getByText('[s0p0] 物理页 1 · 回到原文'));
    await waitFor(() => expect(m.goCite).toHaveBeenCalledWith('hash-view', 'real'));
    expect(m.close).toHaveBeenCalled();
  });
  it('keeps the panel open with a message when the jump fails', async () => {
    m.goCite.mockRejectedValue(new Error('x'));
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    await send();
    fireEvent.click(screen.getByText('[s0p0] 物理页 1 · 回到原文'));
    await screen.findByText('无法跳转到原文位置。');
    expect(m.close).not.toHaveBeenCalled();
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

  const bookRequest = { bookKey: 'hash-view', mode: 'book' as const, seeds: [] };
  it('asks the cloud for extra search words from the question alone, then searches with them', async () => {
    m.expand.mockResolvedValue(['汽车']);
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '轿车' } });
    await prepare();
    expect(m.expand).toHaveBeenCalledTimes(1);
    expect(m.expand.mock.calls[0]![0].question).toBe('轿车');
    expect(Object.keys(m.expand.mock.calls[0]![0]).sort()).toEqual([
      'question',
      'settings',
      'signal',
    ]);
    expect(m.collect.mock.calls[0]![0].extraTerms).toEqual(['汽车']);
    expect(m.answer).not.toHaveBeenCalled();
  });
  it('lets you turn the extra-words step off, and never uses it for selections', async () => {
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '轿车' } });
    fireEvent.click(screen.getByLabelText(/检索前让云端模型为问题补充同义词/));
    await prepare();
    expect(m.expand).not.toHaveBeenCalled();
    cleanup();
    render(<ReadingAssistantPanel request={request} onClose={m.close} />);
    expect(screen.queryByLabelText(/检索前让云端模型为问题补充同义词/)).toBeNull();
    await prepare();
    expect(m.expand).not.toHaveBeenCalled();
  });
  it('does not call the cloud for extra words when AI is off', async () => {
    m.settings.aiSettings.enabled = false;
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '轿车' } });
    await prepare();
    expect(m.expand).not.toHaveBeenCalled();
  });
  it('recap: read range with spoiler protection forced, fixed question, still needs confirmation', async () => {
    render(<ReadingAssistantPanel request={{ ...bookRequest, mode: 'recap' }} onClose={m.close} />);
    expect(screen.getByText('基于你已读到的位置生成前情提要')).toBeTruthy();
    expect(screen.getByLabelText('内容范围')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('内容范围')).toHaveProperty('value', 'read');
    expect(screen.queryByLabelText('向阅读助手提问')).toBeNull();
    expect(screen.queryByText('防剧透：不检索后续内容')).toBeNull();
    await prepare();
    const options = m.collect.mock.calls[0]![0];
    expect(options.recap).toBe(true);
    expect(options.scope).toBe('read');
    expect(options.spoilerProtection).toBe(true);
    expect(options.question).toBe(RECAP_QUESTION);
    expect(m.expand).not.toHaveBeenCalled();
    expect(m.answer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认发送给 AI'));
    await screen.findByText('AI 解读 · 请结合原文判断');
    expect(loadHistory('hash')[0]!.question).toBe('前情提要');
  });
  it('recap can be switched to a normal question', async () => {
    render(<ReadingAssistantPanel request={{ ...bookRequest, mode: 'recap' }} onClose={m.close} />);
    fireEvent.click(screen.getByText('改为自己提问'));
    expect(screen.getByLabelText('向阅读助手提问')).toBeTruthy();
    expect(screen.getByLabelText('内容范围')).toHaveProperty('disabled', false);
  });
  it('"don\'t ask again" sends automatically next time for the same range, with the preview still built', async () => {
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问一' } });
    await prepare();
    fireEvent.click(screen.getByLabelText(/不再逐次确认/));
    fireEvent.click(screen.getByText('确认发送给 AI'));
    await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问二' } });
    fireEvent.click(screen.getByText('准备原文 · 本地检索'));
    await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(2));
    expect(m.collect).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('外发内容预览')).toBeTruthy();
  });
  it('never skips confirmation for a different range, and never for the whole book', async () => {
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问一' } });
    await prepare();
    fireEvent.click(screen.getByLabelText(/不再逐次确认/));
    fireEvent.click(screen.getByText('确认发送给 AI'));
    await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('内容范围'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问二' } });
    await prepare();
    await new Promise((r) => setTimeout(r, 30));
    expect(m.answer).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('内容范围'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问三' } });
    await prepare();
    expect(screen.queryByLabelText(/不再逐次确认/)).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(m.answer).toHaveBeenCalledTimes(1);
  });
  it('a new panel starts asking again (consent is not remembered across opens)', async () => {
    const first = render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问一' } });
    await prepare();
    fireEvent.click(screen.getByLabelText(/不再逐次确认/));
    fireEvent.click(screen.getByText('确认发送给 AI'));
    await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(1));
    first.unmount();
    clearAllConsent();
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问二' } });
    await prepare();
    await new Promise((r) => setTimeout(r, 30));
    expect(m.answer).toHaveBeenCalledTimes(1);
  });
  it('saves each answer to local history, survives reopening, jumps and deletes', async () => {
    const first = render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '历史问题' } });
    await send();
    expect(loadHistory('hash')).toHaveLength(1);
    expect(loadHistory('hash')[0]!.citations[0]!.cfi).toBe('real');
    first.unmount();
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.click(screen.getByText(/本书的助手历史（1 条/));
    expect(screen.getByText('历史问题')).toBeTruthy();
    fireEvent.click(screen.getAllByText('[s0p0] 物理页 1 · 回到原文')[0]!);
    await waitFor(() => expect(m.goCite).toHaveBeenCalledWith('hash-view', 'real'));
    fireEvent.click(screen.getByText('删除这条'));
    expect(loadHistory('hash')).toEqual([]);
    expect(screen.queryByLabelText('本书助手历史')).toBeNull();
  });
  it("clears one book's whole history on request and keeps other books", async () => {
    localStorage.setItem(
      'readest.readingHistory.v1.other',
      JSON.stringify([
        { id: 'o', at: 1, question: 'q', answer: 'a', scope: 'current', citations: [] },
      ]),
    );
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: '问' } });
    await send();
    fireEvent.click(screen.getByText(/本书的助手历史/));
    fireEvent.click(screen.getByText('清空本书历史'));
    expect(loadHistory('hash')).toEqual([]);
    expect(loadHistory('other')).toHaveLength(1);
  });
  it('follow-ups are limited by size, not by a fixed two rounds', async () => {
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    for (let i = 0; i < 5; i++) {
      fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: `问${i}` } });
      await prepare();
      fireEvent.click(screen.getByText('确认发送给 AI'));
      await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(i + 1));
      await screen.findByText('AI 解读 · 请结合原文判断');
    }
    expect(m.answer.mock.calls[4]![0].history).toHaveLength(8);
    expect(m.answer.mock.calls[3]![0].history).toHaveLength(6);
  });
  it('drops the oldest follow-ups once the size budget is exceeded', async () => {
    const long = '长'.repeat(3000);
    m.answer.mockImplementation(async (options) => {
      options.onText(`${long}[s0p0]`);
      return `${long}[s0p0]`;
    });
    render(<ReadingAssistantPanel request={bookRequest} onClose={m.close} />);
    for (let i = 0; i < 4; i++) {
      fireEvent.change(screen.getByLabelText('向阅读助手提问'), { target: { value: `问${i}` } });
      await prepare();
      fireEvent.click(screen.getByText('确认发送给 AI'));
      await waitFor(() => expect(m.answer).toHaveBeenCalledTimes(i + 1));
      await screen.findByText('AI 解读 · 请结合原文判断');
    }
    const sent = m.answer.mock.calls[3]![0].history as { content: string }[];
    expect(sent.length).toBeLessThan(6);
    expect(sent.reduce((n, x) => n + x.content.length, 0)).toBeLessThanOrEqual(
      FOLLOWUP_CHAR_BUDGET + 2000,
    );
  });
});
