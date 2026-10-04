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
});
