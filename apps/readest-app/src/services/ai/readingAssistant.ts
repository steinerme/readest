import { streamText } from 'ai';
import { getAIProvider } from './providers';
import type { AISettings } from './types';
import {
  readingPrompt,
  throwIfCancelled,
  type ReadingPassage,
  type ReadingScope,
} from './readingContext';

export const READING_ACTIONS = {
  plain: '用白话讲清楚这段文字，先一句话概括，再解释重点。',
  example: '解释这段文字，并给一个贴近日常生活的例子，标注例子为 AI 补充。',
  argument: '拆解作者的结论、依据、隐含前提和可能的逻辑跳步。',
  terms: '解释原文中的关键术语，结合上下文而不是只给词典释义。',
  translate: '翻译原文并解释长句结构、语气和容易误解的表达。',
  summary: '概括刚才朗读的内容，保留关键观点，不扩展到未提供的段落。',
} as const;
export type ReadingAction = keyof typeof READING_ACTIONS;

export async function streamReadingAnswer(options: {
  settings: AISettings;
  passages: ReadingPassage[];
  scope: ReadingScope;
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  signal: AbortSignal;
  onText: (text: string) => void;
}): Promise<string> {
  if (!options.settings.enabled) throw new Error('AI_DISABLED');
  if (!options.passages.length) throw new Error('NO_READABLE_TEXT');
  throwIfCancelled(options.signal);
  const result = streamText({
    model: getAIProvider(options.settings).getModel(),
    system: readingPrompt(options.passages, options.scope),
    messages: [
      ...options.history.slice(-4).map((m) => ({ ...m, content: m.content.slice(0, 3000) })),
      { role: 'user', content: options.question.slice(0, 2000) },
    ],
    maxOutputTokens: 2500,
    maxRetries: 0,
    abortSignal: options.signal,
    // Prevent the SDK default error logger from printing backend bodies / headers.
    onError: () => {},
  });
  let answer = '';
  for await (const part of result.textStream) {
    throwIfCancelled(options.signal);
    answer += part;
    options.onText(answer);
  }
  // textStream alone can finish after an SDK error without throwing.
  const finishReason = await result.finishReason;
  if (finishReason === 'error' || !answer.trim()) throw new Error('AI_REQUEST_FAILED');
  throwIfCancelled(options.signal);
  return answer;
}
