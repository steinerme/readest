import { useEffect, useRef, useState } from 'react';
import {
  codexSignedIn,
  startCodexLogin,
  finishCodexLogin,
  logoutCodex,
  CODEX_LOGIN_URL,
  type CodexDevice,
} from '@/services/ai/codexAuth';
import { DEFAULT_CODEX_MODEL, fetchCodexModels } from '@/services/ai/providers/CodexProvider';
import { openExternalUrl } from '@/utils/open';
import { BoxedList } from './primitives';

export default function CodexOAuthSettings({
  model,
  onModelChange,
}: {
  model?: string;
  onModelChange: (value: string) => void;
}) {
  const [signedIn, setSignedIn] = useState(false);
  const [device, setDevice] = useState<CodexDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void codexSignedIn()
      .then((value) => {
        if (active.current) setSignedIn(value);
      })
      .catch(() => {
        if (active.current) setError('安全存储不可用；Codex OAuth 仅支持原生应用');
      });
    return () => {
      active.current = false;
      abort.current?.abort();
    };
  }, []);
  const login = async () => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setDevice(null);
    try {
      const code = await startCodexLogin(controller.signal);
      if (!active.current || controller.signal.aborted) return;
      setDevice(code);
      await finishCodexLogin(code, controller.signal);
      if (active.current && !controller.signal.aborted) {
        setSignedIn(true);
        setDevice(null);
      }
    } catch {
      if (active.current && !controller.signal.aborted)
        setError(
          '登录失败或设备码过期，已停止。请检查网络及 ChatGPT 账号中的设备码授权设置，然后手动重试。',
        );
    } finally {
      if (abort.current === controller) abort.current = null;
      if (active.current) setBusy(false);
    }
  };
  const cancel = () => {
    abort.current?.abort();
    setDevice(null);
  };
  const logout = async () => {
    setBusy(true);
    setError('');
    try {
      await logoutCodex();
      setSignedIn(false);
      setModels([]);
    } catch {
      setError('无法清除登录，请稍后重试');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const refresh = async () => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    try {
      const list = await fetchCodexModels(controller.signal);
      if (active.current) setModels(list);
    } catch {
      if (active.current && !controller.signal.aborted)
        setError('模型列表读取失败；可手动填写有权限的模型 ID');
    } finally {
      if (abort.current === controller) abort.current = null;
      if (active.current) setBusy(false);
    }
  };
  return (
    <BoxedList title='Codex OAuth · ChatGPT'>
      <div className='space-y-3 p-3 text-sm'>
        <p>
          使用你的 ChatGPT 账号及 Codex 额度，不是 OpenAI API Key。可用模型和额度取决于账号权限。
        </p>
        <p>
          授权在系统浏览器完成；访问/刷新令牌只保存在系统安全存储，不写入普通设置、备份或书籍笔记。不会读取
          Minis 的账号。
        </p>
        <p role='status'>{signedIn ? '已登录' : busy ? '等待授权…' : '未登录'}</p>
        {!signedIn && !busy && (
          <button type='button' className='btn btn-outline' onClick={() => void login()}>
            获取设备码登录
          </button>
        )}
        {device && (
          <div className='space-y-2 rounded-xl bg-base-200 p-3'>
            <p>在浏览器输入此设备码（15 分钟内有效）：</p>
            <p className='select-text text-2xl font-mono tracking-widest'>{device.user_code}</p>
            <button
              type='button'
              className='btn btn-primary'
              onClick={() => openExternalUrl(CODEX_LOGIN_URL)}
            >
              在系统浏览器授权
            </button>
            <p>
              授权后返回此页面，自动完成检查。若账号禁用设备码登录，请先在 ChatGPT 安全设置启用。
            </p>
          </div>
        )}
        {busy && (
          <button type='button' className='btn btn-ghost' onClick={cancel}>
            取消
          </button>
        )}
        {signedIn && (
          <div className='flex flex-wrap gap-2'>
            <button
              type='button'
              disabled={busy}
              className='btn btn-outline'
              onClick={() => void refresh()}
            >
              刷新模型列表
            </button>
            <button
              type='button'
              disabled={busy}
              className='btn btn-ghost'
              onClick={() => void logout()}
            >
              退出登录并清除令牌
            </button>
          </div>
        )}
        <label className='block'>
          模型 ID
          <input
            className='input input-bordered mt-1 w-full'
            value={model || DEFAULT_CODEX_MODEL}
            list='codex-models'
            onChange={(event) => onModelChange(event.target.value)}
          />
        </label>
        <datalist id='codex-models'>
          {models.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <p>仅在点击刷新或测试连接时读取模型列表。阅读内容仍需逐次预览并确认发送给 OpenAI。</p>
        {error && (
          <p role='alert' className='text-error'>
            {error}
          </p>
        )}
      </div>
    </BoxedList>
  );
}
