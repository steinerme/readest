import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/components/Menu', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/MenuItem', () => ({
  default: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{label}</button>
  ),
}));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch } }));
import QuickActionMenu from '@/app/reader/components/annotator/QuickActionMenu';
import { annotationToolQuickActions } from '@/app/reader/components/annotator/AnnotationTools';
import ReadingAIFloatingButton from '@/app/reader/components/ai/ReadingAIFloatingButton';
import type { AnnotationToolType } from '@/types/annotator';
class Observer {
  observe() {}
  disconnect() {}
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', Observer);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('reader AI discoverability', () => {
  it.each([
    'copy',
    'highlight',
    'translate',
    'dictionary',
    'tts',
  ] as AnnotationToolType[])('explicitly disables %s without selecting another tool', (action) => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <QuickActionMenu
        selectedAction={action}
        onActionSelect={onSelect}
        setIsDropdownOpen={onClose}
      />,
    );
    fireEvent.click(screen.getByText('关闭即时功能 · 恢复选区工具栏'));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalledWith(false);
  });
  it('same action toggles off then can be re-enabled', () => {
    function Harness() {
      const [action, setAction] = useState<AnnotationToolType | null>('copy');
      return (
        <>
          <output>{action || 'off'}</output>
          <QuickActionMenu
            selectedAction={action}
            onActionSelect={(next) => setAction(next === action ? null : next)}
          />
        </>
      );
    }
    render(<Harness />);
    const buttons = screen.getAllByText('Instant {{action}}', { selector: 'button' });
    // copy is identified by its quick-action tooltip order, not a duplicated translated label.
    const copyIndex = annotationToolQuickActions.findIndex((button) => button.type === 'copy');
    fireEvent.click(buttons[copyIndex]!);
    expect(screen.getByText('off')).toBeTruthy();
    fireEvent.click(buttons[copyIndex]!);
    expect(screen.getByText('copy')).toBeTruthy();
  });
  it('places the floating button above visible footer and listening player', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.hasAttribute('data-view-transition-root')
        ? 0
        : this.hasAttribute('data-reading-tts-player')
          ? 700
          : 850;
      return {
        top,
        bottom: this.hasAttribute('data-view-transition-root') ? 915 : 915,
        height: 915 - top,
        width: 412,
        left: 0,
        right: 412,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    });
    try {
      render(
        <div data-view-transition-root=''>
          <div className='footer-bar' data-visible='true' />
          <div data-reading-tts-player='visible' />
          <ReadingAIFloatingButton bookKey='book-test' />
        </div>,
      );
      expect(screen.getByRole('button', { name: '问这本书' }).style.bottom).toBe('231px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
  it('stays above an open font/layout panel so More Settings is never covered', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.hasAttribute('data-view-transition-root')
        ? 0
        : this.getAttribute('data-state') === 'open'
          ? 520
          : 850;
      return {
        top,
        bottom: 915,
        height: 915 - top,
        width: 412,
        left: 0,
        right: 412,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    });
    try {
      render(
        <div data-view-transition-root=''>
          <div className='footer-bar' data-visible='true'>
            <div data-state='open' />
            <div data-state='closed' />
          </div>
          <ReadingAIFloatingButton bookKey='book-test' />
        </div>,
      );
      expect(screen.getByRole('button', { name: '问这本书' }).style.bottom).toBe('411px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
  it('floating AI dispatches correct book and does not cause a page turn', () => {
    const turn = vi.fn();
    render(
      <div onClick={turn}>
        <ReadingAIFloatingButton bookKey='book-test' bottomInset={16} />
      </div>,
    );
    const button = screen.getByRole('button', { name: '问这本书' });
    fireEvent.click(button);
    expect(turn).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('reading-ai-open', {
      bookKey: 'book-test',
      mode: 'book',
    });
    expect(button.className).toContain('absolute');
    expect(button.style.bottom).toBe('40px');
  });
});
