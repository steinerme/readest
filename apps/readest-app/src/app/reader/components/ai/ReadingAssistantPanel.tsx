import { useEffect, useRef, useState } from 'react';
import Dialog from '@/components/Dialog';
import ModalPortal from '@/components/ModalPortal';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { usePdfReflowStore } from '@/store/pdfReflowStore';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import {
  READING_ACTIONS,
  expandQueryTerms,
  streamReadingAnswer,
  type ReadingAction,
} from '@/services/ai/readingAssistant';
import {
  RECAP_QUESTION,
  collectReadingContext,
  citedPassages,
  type ReadingContext,
  type ReadingPassage,
  type ReadingScope,
  type ReadingSeed,
} from '@/services/ai/readingContext';
import {
  pauseReading,
  resumeReading,
  readingController,
  speakReadingAnswer,
  warmReadingSpeech,
  type ReadingSpeechProgress,
} from '@/services/ai/readingSpeech';
import {
  appendHistory,
  clearHistory,
  deleteHistoryEntry,
  loadHistory,
  type HistoryEntry,
} from '@/services/ai/readingHistory';
import {
  canSkipConfirmation,
  consentKey,
  hasConsent,
  setConsent,
} from '@/services/ai/readingConsent';
import { goToCitation } from '@/services/ai/readingNavigation';
import { bookHashOf, getOpenedResume } from '@/services/ai/readingResume';
import { getPdfRendererPage } from '@/utils/pdfRendererPage';
import { eventDispatcher } from '@/utils/event';
import { uniqueId } from '@/utils/misc';
import type { ReadingAssistantRequest } from './ReadingAssistantHost';

const actionLabels: Record<ReadingAction, string> = {
  plain: '讲白话',
  example: '举个例子',
  argument: '拆解论证',
  terms: '解释术语',
  translate: '翻译并解释',
  summary: '概括刚才内容',
};
interface Turn {
  question: string;
  answer: string;
  context: ReadingContext;
  scope: ReadingScope;
  protect: boolean;
}
type Props = {
  request: ReadingAssistantRequest & { seeds: ReadingSeed[] };
  onClose: () => void;
};
export default function ReadingAssistantPanel({ request, onClose }: Props) {
  const { bookKey } = request;
  const listening = request.mode === 'listening';
  const selection = request.mode === 'selection';
  const recap = request.mode === 'recap';
  const hash = bookHashOf(bookKey);
  const { envConfig } = useEnv();
  const settings = useSettingsStore((s) => s.settings);
  const ai = settings.aiSettings ?? DEFAULT_AI_SETTINGS;
  const data = useBookDataStore((s) => s.getBookData(bookKey));
  const book = data?.book;
  const bookDoc = data?.bookDoc;
  const view = useReaderStore.getState().getView(bookKey);
  const [scope, setScope] = useState<ReadingScope>(
    selection ? 'selection' : listening ? 'listening' : recap ? 'read' : 'current',
  );
  const [protect, setProtect] = useState(true);
  const [question, setQuestion] = useState(
    selection || listening ? READING_ACTIONS.plain : recap ? RECAP_QUESTION : '',
  );
  const [expand, setExpand] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(hash));
  const [showHistory, setShowHistory] = useState(false);
  const [skipConfirm, setSkipConfirm] = useState(false);
  // A recap is only ever the "read" range; it never carries a free-form question.
  const [recapMode, setRecapMode] = useState(recap);
  const [context, setContext] = useState<ReadingContext | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'prepare' | 'request' | 'speech' | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [pauseForAI, setPauseForAI] = useState(true);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [autoResume, setAutoResume] = useState(true);
  const [saved, setSaved] = useState(false);
  // What the explanation voice is doing right now, shown next to the answer.
  const [speech, setSpeech] = useState<ReadingSpeechProgress | null>(null);
  const [speechOutcome, setSpeechOutcome] = useState('');
  const abort = useRef<AbortController | null>(null);
  const pendingAutoSend = useRef(false);
  const operationLock = useRef(false);
  const savingLock = useRef(false);
  const active = useRef(true);
  const pausedController = useRef<object | undefined>(undefined);
  const source = useRef({
    sectionIndex:
      request.seed?.sectionIndex ??
      (listening ? request.seeds.at(-1)?.sectionIndex : undefined) ??
      usePdfReflowStore.getState().sessions[bookKey]?.page ??
      (book?.format === 'PDF' ? getPdfRendererPage(view?.renderer) : view?.renderer.primaryIndex) ??
      0,
    boundaryCfi: view?.lastLocation?.cfi,
  });
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      abort.current?.abort();
    };
  }, []);

  const close = () => {
    active.current = false;
    abort.current?.abort();
    onClose();
  };
  const invalidate = () => {
    abort.current?.abort();
    setContext(null);
    setAnswer('');
    setError('');
    setSaved(false);
  };
  const changeQuestion = (text: string) => {
    setQuestion(text);
    invalidate();
  };
  const ensurePaused = async () => {
    const controller = readingController(bookKey);
    if (!controller) return;
    if (controller.state === 'playing') {
      if (!(await pauseReading(bookKey))) throw new Error('PAUSE_FAILED');
      pausedController.current = controller;
    } else if (controller.state.includes('paused')) pausedController.current = controller;
  };
  const destinationNow = () => {
    const endpoint =
      ai.provider === 'codex'
        ? 'https://chatgpt.com/backend-api/codex'
        : ai.provider === 'openrouter'
          ? ai.openrouterBaseUrl
          : ai.provider === 'ollama'
            ? ai.ollamaBaseUrl
            : 'Vercel AI Gateway';
    return safeDestination(endpoint ?? '');
  };
  const currentConsentKey = () => consentKey(hash, scope, protect, destinationNow());
  const prepare = async (options: { autoSend?: boolean } = {}) => {
    if (operationLock.current || busy || !bookDoc || !view || !question.trim()) return;
    operationLock.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setBusy('prepare');
    setError('');
    setAnswer('');
    setContext(null);
    setSaved(false);
    try {
      if (listening && pauseForAI) await ensurePaused();
      // Question-only request for extra search words. Never includes book text,
      // and any failure just means we search with the question's own words.
      let extraTerms: string[] = [];
      const retrieving = scope === 'current' || scope === 'read' || scope === 'all';
      if (expand && ai.enabled && retrieving && !recapMode) {
        setProgress('正在向云端扩展检索词…');
        extraTerms = await expandQueryTerms({ settings: ai, question, signal: controller.signal });
        setProgress('');
      }
      const result = await collectReadingContext({
        bookDoc,
        view,
        scope,
        sectionIndex: source.current.sectionIndex,
        question,
        isPdf: book?.format === 'PDF',
        // A recap must never reveal text past the reader's position.
        spoilerProtection: recapMode ? true : protect,
        boundaryCfi: source.current.boundaryCfi,
        seeds: scope === 'selection' ? (request.seed ? [request.seed] : []) : request.seeds,
        recap: recapMode,
        extraTerms,
        signal: controller.signal,
        onProgress: (current, total) => {
          if (active.current) setProgress(`${current} / ${total}`);
        },
      });
      if (!active.current || controller.signal.aborted) return;
      if (!result.passages.length) throw new Error('NO_READABLE_TEXT');
      setContext(result);
      pendingAutoSend.current = !!options.autoSend && !!result.passages.length;
    } catch (e) {
      if (active.current && !controller.signal.aborted) setError(friendlyError(e));
    } finally {
      operationLock.current = false;
      if (active.current) setBusy(null);
    }
  };
  const send = async () => {
    if (operationLock.current || busy || !context || !ai.enabled) return;
    if (skipConfirm && canSkipConfirmation(scope)) setConsent(currentConsentKey(), true);
    else setConsent(currentConsentKey(), false);
    operationLock.current = true;
    const controller = new AbortController();
    abort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 120000);
    setBusy('request');
    setError('');
    setAnswer('');
    try {
      const response = await streamReadingAnswer({
        settings: ai,
        passages: context.passages,
        scope,
        question,
        // Only contiguous turns from the same scope/protection policy may
        // follow a new question; never carry all-book spoilers into read scope.
        history: followupHistory(turns, scope, protect),
        signal: controller.signal,
        onText: (text) => {
          if (active.current && !controller.signal.aborted) setAnswer(text);
        },
      });
      if (!active.current || controller.signal.aborted) return;
      setTurns((old) => [
        ...old.slice(-19),
        { question, answer: response, context, scope, protect },
      ]);
      setHistory(
        appendHistory(hash, {
          id: uniqueId(),
          at: Date.now(),
          question: recapMode ? '前情提要' : question,
          answer: response,
          scope,
          citations: citedPassages(response, context.passages).map((p) => ({
            id: p.id,
            label: p.label,
            cfi: p.cfi,
            sectionIndex: p.sectionIndex,
          })),
        }),
      );
    } catch (e) {
      if (active.current) {
        setAnswer('');
        setError(controller.signal.aborted ? '请求已取消或超时，没有自动重试。' : friendlyError(e));
      }
    } finally {
      clearTimeout(timeout);
      operationLock.current = false;
      if (active.current) setBusy(null);
    }
  };
  const savePassage = async (passage: ReadingPassage, note: string) => {
    if (!passage.cfi) throw new Error('ANCHOR_UNAVAILABLE');
    const store = useBookDataStore.getState();
    const config = store.getConfig(bookKey);
    if (!config) throw new Error('BOOK_CLOSED');
    const timestamp = Date.now();
    const updated = store.updateBooknotes(bookKey, [
      ...(config.booknotes ?? []),
      {
        id: uniqueId(),
        type: 'annotation',
        cfi: passage.cfi,
        text: passage.text,
        note,
        bookHash: book?.hash,
        ...(book?.format === 'PDF' ? { page: passage.sectionIndex + 1 } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    if (!updated) throw new Error('BOOK_CLOSED');
    await store.saveConfig(envConfig, bookKey, updated, useSettingsStore.getState().settings);
    if (active.current) setSaved(true);
  };
  const save = async (raw = false) => {
    if (savingLock.current || saved) return;
    savingLock.current = true;
    try {
      const latest = turns.at(-1);
      const passage = raw
        ? request.seeds.at(-1)
          ? {
              ...request.seeds.at(-1)!,
              cfi: request.seeds.at(-1)!.cfi ?? '',
              id: 'listening',
              label: '最近朗读',
            }
          : null
        : latest
          ? (citedPassages(latest.answer, latest.context.passages)[0] ?? latest.context.passages[0])
          : null;
      if (!passage) throw new Error('NO_READABLE_TEXT');
      await savePassage(
        passage,
        raw
          ? '【听书记录 · 原文】'
          : `【AI 解读，仅供参考】\n问题：${latest?.question}\n\n${latest?.answer}`,
      );
    } catch (e) {
      if (active.current) setError(friendlyError(e));
    } finally {
      savingLock.current = false;
    }
  };
  const jump = async (passage: { cfi: string }) => {
    try {
      await goToCitation(bookKey, passage.cfi);
      close();
    } catch {
      setError('无法跳转到原文位置。');
    }
  };
  const speak = async () => {
    if (operationLock.current || busy || !answer || !voiceConsent) return;
    operationLock.current = true;
    warmReadingSpeech();
    const controller = new AbortController();
    abort.current = controller;
    setBusy('speech');
    setError('');
    setSpeechOutcome('');
    setSpeech({ phase: 'synthesizing', chunk: 1, total: 1 });
    let resumed = false;
    let interrupted = false;
    try {
      await ensurePaused();
      if (!active.current || controller.signal.aborted) return;
      const original = pausedController.current;
      const playback = (event: CustomEvent) => {
        if (event.detail?.state === 'playing') {
          interrupted = true;
          controller.abort();
        }
      };
      eventDispatcher.on('tts-playback-state', playback);
      try {
        await speakReadingAnswer({
          text: answer,
          signal: controller.signal,
          onProgress: (p) => {
            if (active.current && !controller.signal.aborted) setSpeech(p);
          },
        });
      } finally {
        eventDispatcher.off('tts-playback-state', playback);
      }
      if (active.current && !controller.signal.aborted && autoResume && original) {
        resumed = await resumeReading(bookKey, original);
      }
      if (active.current && !controller.signal.aborted)
        setSpeechOutcome(
          resumed
            ? '解释已读完，已继续原文。'
            : autoResume && original
              ? '解释已读完。原文播放器已变化，没有自动继续。'
              : '解释已读完。',
        );
    } catch (e) {
      if (active.current && !controller.signal.aborted) setError(friendlyError(e));
    } finally {
      operationLock.current = false;
      if (active.current) {
        setBusy(null);
        setSpeech(null);
        if (controller.signal.aborted)
          setSpeechOutcome(
            interrupted ? '原文已开始播放，解释朗读已停止。' : '已停止解释朗读，原文保持暂停。',
          );
      }
    }
  };
  const openSettings = () => {
    close();
    const store = useSettingsStore.getState();
    store.setSettingsDialogBookKey(bookKey);
    store.setRequestedPanel('AI');
    store.setSettingsDialogOpen(true);
  };
  // With "don't ask again for this range" on, the preview is still built (and
  // shown) but the request goes out without an extra tap.
  useEffect(() => {
    if (!context || !pendingAutoSend.current) return;
    pendingAutoSend.current = false;
    if (!hasConsent(currentConsentKey()) || !canSkipConfirmation(scope)) return;
    void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);
  const latest = turns.at(-1);
  const references =
    latest && answer === latest.answer ? citedPassages(answer, latest.context.passages) : [];
  const destination = destinationNow();
  return (
    <ModalPortal showOverlay={false}>
      <Dialog
        isOpen={true}
        snapHeight={0.88}
        title={
          listening
            ? 'AI 听书助手'
            : selection
              ? 'AI 解释选中文字'
              : recapMode
                ? '前情提要'
                : '问这本书'
        }
        onClose={close}
        boxClassName='max-w-2xl'
        contentClassName='px-4 pb-6'
      >
        <div className='flex min-w-0 flex-col gap-4 text-sm' onClick={(e) => e.stopPropagation()}>
          <div className='flex items-center justify-between gap-3'>
            <span className='truncate font-semibold'>{book?.title}</span>
            <button className='btn btn-ghost btn-sm shrink-0' onClick={openSettings}>
              AI 设置
            </button>
          </div>
          {!ai.enabled && (
            <p className='rounded-xl bg-base-200 p-3'>
              尚未启用 AI。请在 AI 设置中启用，并配置模型与 API。检索原文可以离线使用。
            </p>
          )}
          {recapMode && (
            <div className='rounded-xl bg-base-200 p-3'>
              <p className='font-semibold'>基于你已读到的位置生成前情提要</p>
              {getOpenedResume(bookKey) && (
                <p className='mt-1 break-words text-base-content/70'>
                  上次读到：{getOpenedResume(bookKey)!.label || '上次的位置'}
                  {getOpenedResume(bookKey)!.page
                    ? ` · 第 ${getOpenedResume(bookKey)!.page} 页`
                    : ''}
                </p>
              )}
              <p className='mt-1 text-xs text-base-content/60'>
                只使用已读部分，不含后文；取最近几段加早先内容的均匀抽样，不是通读全文。
              </p>
              <button
                type='button'
                className='btn btn-ghost btn-xs mt-2'
                disabled={!!busy}
                onClick={() => {
                  setRecapMode(false);
                  setQuestion('');
                  invalidate();
                }}
              >
                改为自己提问
              </button>
            </div>
          )}
          <label className='flex items-center gap-2'>
            内容范围
            <select
              aria-label='内容范围'
              className='select select-sm min-w-0 flex-1'
              value={scope}
              disabled={!!busy || recapMode}
              onChange={(e) => {
                setScope(e.target.value as ReadingScope);
                invalidate();
              }}
            >
              {selection && <option value='selection'>选中文字</option>}
              {listening && <option value='listening'>最近朗读内容（最多 8 段）</option>}
              <option value='current'>
                {book?.format === 'PDF' ? '当前章节（无目录时用物理页）' : '当前章节'}
              </option>
              <option value='read'>截至打开助手时的已读部分</option>
              <option value='all'>全书本地检索（可能剧透）</option>
            </select>
          </label>
          {!recapMode && scope !== 'selection' && scope !== 'listening' && scope !== 'all' && (
            <label className='flex items-center gap-2'>
              <input
                type='checkbox'
                checked={protect}
                disabled={!!busy}
                onChange={(e) => {
                  setProtect(e.target.checked);
                  invalidate();
                }}
              />
              防剧透：不检索后续内容
            </label>
          )}
          {scope === 'all' && (
            <p className='text-warning'>
              全书范围会检索未读内容，可能剧透；只发送检索出的片段，不发送整个文件。
            </p>
          )}
          {listening && (
            <>
              <p className='text-base-content/70'>
                上下文取自本次听书会话。首次打开可能只有当前一句；不会猜测你之前听过什么。
              </p>
              <label className='flex items-center gap-2'>
                <input
                  type='checkbox'
                  checked={pauseForAI}
                  disabled={!!busy}
                  onChange={(e) => setPauseForAI(e.target.checked)}
                />
                准备解释时暂停原文，保留原位置
              </label>
              <div className='flex flex-wrap gap-2'>
                <button
                  className='btn btn-outline btn-sm'
                  disabled={!!busy || !request.seeds.length || saved}
                  onClick={() => void save(true)}
                >
                  把刚才的原文记下来
                </button>
                <button
                  className='btn btn-outline btn-sm'
                  disabled={!!busy}
                  onClick={async () => {
                    await resumeReading(bookKey, pausedController.current);
                    close();
                  }}
                >
                  返回并继续原文
                </button>
              </div>
            </>
          )}
          {(selection || listening) && (
            <div className='flex flex-wrap gap-2'>
              {(Object.keys(READING_ACTIONS) as ReadingAction[])
                .filter((a) => listening || a !== 'summary')
                .map((action) => (
                  <button
                    key={action}
                    className='btn btn-outline btn-sm'
                    disabled={!!busy}
                    onClick={() => changeQuestion(READING_ACTIONS[action])}
                  >
                    {actionLabels[action]}
                  </button>
                ))}
            </div>
          )}
          {!recapMode && (
            <textarea
              aria-label='向阅读助手提问'
              className='textarea w-full min-h-24'
              maxLength={2000}
              value={question}
              disabled={!!busy}
              placeholder='例如：作者为什么得出这个结论？这和前文有什么关系？'
              onChange={(e) => changeQuestion(e.target.value)}
            />
          )}
          {!recapMode && (scope === 'current' || scope === 'read' || scope === 'all') && (
            <label className='flex items-start gap-2 text-xs'>
              <input
                type='checkbox'
                checked={expand}
                disabled={!!busy}
                onChange={(e) => {
                  setExpand(e.target.checked);
                  invalidate();
                }}
              />
              <span>
                检索前让云端模型为问题补充同义词（只发送你的问题，不发送书中文字；失败会自动退回本地检索）
              </span>
            </label>
          )}
          <div className='flex flex-wrap gap-2'>
            <button
              className='btn btn-primary btn-sm'
              disabled={!!busy || !question.trim()}
              onClick={() => void prepare({ autoSend: true })}
            >
              {busy === 'prepare' ? `正在检索 ${progress}` : '准备原文 · 本地检索'}
            </button>
            {busy && (
              <button className='btn btn-outline btn-sm' onClick={() => abort.current?.abort()}>
                取消{busy === 'speech' ? '解释朗读' : '当前操作'}
              </button>
            )}
          </div>
          {context && (
            <section className='rounded-xl bg-base-200 p-3' aria-label='外发内容预览'>
              <p className='font-semibold'>发送前确认</p>
              <p className='my-2 break-words'>
                目标：{destination}；将发送你的问题和以下 {context.passages.length} 个原文片段（
                {context.passages.reduce((n, p) => n + p.text.length, 0)}{' '}
                字符）。不发送书籍文件、其他书籍或笔记。
              </p>
              <p className='text-xs text-base-content/70'>
                使用本地关键词检索，不需要 embedding 模型。AI
                仍可能理解错误，来源编号只是定位证据，不等于答案已验证。
              </p>
              {followupHistory(turns, scope, protect).length > 0 && (
                <details className='my-2'>
                  <summary className='cursor-pointer'>
                    此次还会发送最近同范围的问答，供继续追问
                  </summary>
                  {followupHistory(turns, scope, protect).map((message, i) => (
                    <p key={i} className='my-2 whitespace-pre-wrap break-words'>
                      {message.role === 'user' ? '问题' : '回答'}：{message.content.slice(0, 3000)}
                    </p>
                  ))}
                </details>
              )}
              {context.warnings.map((warning, i) => (
                <p key={i} className='mt-2 text-warning'>
                  {warning}
                </p>
              ))}
              <details className='my-3'>
                <summary className='cursor-pointer'>查看即将发送的原文</summary>
                <div className='max-h-64 overflow-y-auto'>
                  {context.passages.map((p) => (
                    <div key={p.id} className='my-3'>
                      <p className='font-semibold'>
                        [{p.id}] {p.label}
                      </p>
                      <p className='whitespace-pre-wrap break-words'>{p.text}</p>
                    </div>
                  ))}
                </div>
              </details>
              {canSkipConfirmation(scope) && (
                <label className='mb-2 flex items-start gap-2 text-xs'>
                  <input
                    type='checkbox'
                    checked={skipConfirm || hasConsent(currentConsentKey())}
                    disabled={!!busy}
                    onChange={(e) => {
                      setSkipConfirm(e.target.checked);
                      if (!e.target.checked) setConsent(currentConsentKey(), false);
                    }}
                  />
                  <span>
                    本次阅读中，这本书同一范围、同一服务不再逐次确认（仍会显示发送内容；重启应用后恢复确认）
                  </span>
                </label>
              )}
              <button
                className='btn btn-primary btn-sm'
                disabled={!!busy || !ai.enabled}
                onClick={() => void send()}
              >
                确认发送给 AI
              </button>
            </section>
          )}
          {error && (
            <p role='alert' className='rounded-xl bg-error/10 p-3 text-error'>
              {error}
            </p>
          )}
          {answer && (
            <section
              aria-label='AI 回答'
              className='space-y-3 rounded-xl border border-base-300 p-3'
            >
              <p className='font-semibold'>
                {busy === 'request' ? 'AI 正在回答…' : 'AI 解读 · 请结合原文判断'}
              </p>
              <p className='whitespace-pre-wrap break-words select-text'>{answer}</p>
              {!busy && references.length === 0 && (
                <p className='text-warning'>
                  答案未提供可识别的原文引用，不应当作已证实的书内结论。
                </p>
              )}
              {references.length > 0 && (
                <div className='flex flex-wrap gap-2'>
                  {references.map((p) => (
                    <button
                      key={p.id}
                      className='btn btn-outline btn-sm'
                      onClick={() => void jump(p)}
                    >
                      [{p.id}] {p.label} · 回到原文
                    </button>
                  ))}
                </div>
              )}
              {!busy && (
                <>
                  <button
                    className='btn btn-outline btn-sm'
                    disabled={saved}
                    onClick={() => void save()}
                  >
                    {saved ? '已保存到书籍笔记' : '保存 AI 解读为笔记'}
                  </button>
                  <label className='flex items-start gap-2'>
                    <input
                      type='checkbox'
                      checked={voiceConsent}
                      onChange={(e) => setVoiceConsent(e.target.checked)}
                    />
                    <span>
                      允许将本条 AI 回答发送给微软 Edge 语音服务，朗读解释（与原文播放器隔离）
                    </span>
                  </label>
                  <label className='flex items-center gap-2'>
                    <input
                      type='checkbox'
                      checked={autoResume}
                      onChange={(e) => setAutoResume(e.target.checked)}
                    />
                    解释正常读完后继续原文
                  </label>
                  <button
                    className='btn btn-outline btn-sm'
                    disabled={!voiceConsent}
                    onClick={() => void speak()}
                  >
                    朗读解释{autoResume ? '，然后继续原文' : ''}
                  </button>
                  {speechOutcome && (
                    <p role='status' className='text-sm text-base-content/70'>
                      {speechOutcome}
                    </p>
                  )}
                </>
              )}
              {busy === 'speech' && (
                <div
                  role='status'
                  aria-live='polite'
                  aria-label='解释朗读状态'
                  className='flex items-center gap-3 rounded-lg bg-base-200 p-2'
                >
                  <span className='loading loading-bars loading-sm' aria-hidden='true' />
                  <span className='flex-1 text-sm'>{speechLabel(speech)}</span>
                  <button className='btn btn-outline btn-sm' onClick={() => abort.current?.abort()}>
                    停止解释朗读
                  </button>
                </div>
              )}
            </section>
          )}
          {history.length > 0 && (
            <section aria-label='本书助手历史' className='rounded-xl border border-base-300 p-3'>
              <button
                type='button'
                className='flex w-full items-center justify-between font-semibold'
                aria-expanded={showHistory}
                onClick={() => setShowHistory((v) => !v)}
              >
                <span>本书的助手历史（{history.length} 条，仅存于本机）</span>
                <span aria-hidden='true'>{showHistory ? '收起' : '展开'}</span>
              </button>
              {showHistory && (
                <div className='mt-3 space-y-3'>
                  {[...history].reverse().map((entry) => (
                    <div key={entry.id} className='rounded-xl bg-base-200 p-3'>
                      <p className='text-xs text-base-content/60'>
                        {new Date(entry.at).toLocaleString()}
                      </p>
                      <p className='mt-1 font-semibold break-words'>{entry.question}</p>
                      <p className='mt-1 whitespace-pre-wrap break-words select-text'>
                        {entry.answer}
                      </p>
                      <div className='mt-2 flex flex-wrap gap-2'>
                        {entry.citations.map((c) => (
                          <button
                            key={c.id}
                            type='button'
                            className='btn btn-outline btn-xs'
                            onClick={() => void jump(c)}
                          >
                            [{c.id}] {c.label} · 回到原文
                          </button>
                        ))}
                        <button
                          type='button'
                          className='btn btn-ghost btn-xs text-error'
                          onClick={() => setHistory(deleteHistoryEntry(hash, entry.id))}
                        >
                          删除这条
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    type='button'
                    className='btn btn-ghost btn-sm text-error'
                    onClick={() => {
                      clearHistory(hash);
                      setHistory([]);
                    }}
                  >
                    清空本书历史
                  </button>
                </div>
              )}
            </section>
          )}
          {turns.length > 1 && (
            <details>
              <summary className='cursor-pointer'>
                本次阅读助手记录（{turns.length - 1} 条）
              </summary>
              {turns.slice(0, -1).map((turn, i) => (
                <div key={i} className='my-3 rounded-xl bg-base-200 p-3'>
                  <p className='font-semibold'>{turn.question}</p>
                  <p className='whitespace-pre-wrap break-words'>{turn.answer}</p>
                </div>
              ))}
            </details>
          )}
          <p className='text-xs text-base-content/60'>
            关闭助手会取消请求和解释语音，不会擅自恢复播放。问答会保存在本机的“本书助手历史”中，不同步、不上传，可随时删除；请求和解释语音仍会在关闭时取消。
          </p>
        </div>
      </Dialog>
    </ModalPortal>
  );
}

function safeDestination(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return endpoint === 'Vercel AI Gateway' ? endpoint : '请检查 AI 设置';
  }
}
/** Plain-language state of the explanation voice. */
export function speechLabel(p: ReadingSpeechProgress | null): string {
  if (!p) return '正在准备解释语音…';
  const part = p.total > 1 ? `（第 ${p.chunk}/${p.total} 段）` : '';
  return p.phase === 'playing' ? `正在朗读解释${part}` : `正在生成解释语音${part}…`;
}
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'NO_READABLE_TEXT')
    return '没有可用原文：请重新选择文字，或开始朗读后再打开。扫描 PDF 暂不支持。';
  if (message === 'PAUSE_FAILED') return '原文暂停失败，为避免串音，没有播放解释。';
  if (message === 'AI_DISABLED') return '请先在 AI 设置中启用助手。';
  if (message === 'ANCHOR_UNAVAILABLE') return '这段文字没有可靠原文锚点，不能保存为定位笔记。';
  if (message === 'BOOK_CLOSED') return '书籍已关闭，不能保存笔记。';
  if (/VOICE|AudioContext/i.test(message)) return '解释语音不可用，原文保持暂停，可以手动继续。';
  if (message.includes('2000')) return message;
  // Never surface a provider body: some backends echo Authorization / keys.
  return '操作失败。请检查 API 地址、密钥、模型或网络；没有自动重试。';
}

// Follow-ups are limited by size, not by a fixed number of rounds: as many of the
// most recent same-range turns as fit in this budget go back with the next question.
export const FOLLOWUP_CHAR_BUDGET = 6000;
function followupHistory(turns: Turn[], scope: ReadingScope, protect: boolean) {
  const recent: Turn[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    if (turn.scope !== scope || turn.protect !== protect) break;
    const size = Math.min(turn.question.length, 2000) + Math.min(turn.answer.length, 3000);
    if (recent.length && used + size > FOLLOWUP_CHAR_BUDGET) break;
    if (!recent.length && size > FOLLOWUP_CHAR_BUDGET) break;
    used += size;
    recent.unshift(turn);
  }
  return recent.flatMap((turn) => [
    { role: 'user' as const, content: turn.question },
    { role: 'assistant' as const, content: turn.answer },
  ]);
}
