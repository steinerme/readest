import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReflowSelectionMenu } from '@/app/reader/hooks/useReflowSelectionMenu';
const set = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/utils/bridge', () => ({ setSelectionSuppressed: set }));
function Harness({ android = true }: { android?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useReflowSelectionMenu(ref, android);
  return <><article ref={ref}><p>reader selected text</p></article><input aria-label='search' defaultValue='editable text' /></>;
}
function select() {
  const range = document.createRange(); range.selectNodeContents(screen.getByText('reader selected text'));
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));
  return selection;
}
beforeEach(() => { vi.useFakeTimers(); set.mockClear(); window.getSelection()?.removeAllRanges(); });
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.useRealTimers(); });
describe('reflow Android system-menu gate', () => {
  it('arms on pointerdown BEFORE native long press without deleting selection', () => {
    render(<Harness />); fireEvent.pointerDown(screen.getByText('reader selected text'));
    expect(set).toHaveBeenLastCalledWith({ target: 'menu', suppressed: true });
    const selection = select();
    fireEvent.pointerUp(document);
    act(() => vi.advanceTimersByTime(200));
    expect(selection.toString()).toBe('reader selected text');
    expect(set).toHaveBeenCalledTimes(1);
  });
  it('cancelled scroll or a simple tap does not leave input menus disabled', () => {
    render(<Harness />); fireEvent.pointerDown(screen.getByText('reader selected text'));
    fireEvent.pointerCancel(document);
    act(() => vi.advanceTimersByTime(200));
    expect(set).toHaveBeenLastCalledWith({ target: 'menu', suppressed: false });
  });
  it('handles touch fallback and preserves a selection committed after pointercancel', () => {
    render(<Harness />); fireEvent.touchStart(screen.getByText('reader selected text'));
    fireEvent.pointerCancel(document); const selection = select();
    act(() => vi.advanceTimersByTime(200));
    expect(selection.toString()).toBe('reader selected text');
    expect(set).toHaveBeenLastCalledWith({ target: 'menu', suppressed: true });
  });
  it('cancels article context menu but not editable menu', () => {
    render(<Harness />);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(screen.getByText('reader selected text'), event); expect(event.defaultPrevented).toBe(true);
    const inputEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('textbox'), inputEvent); expect(inputEvent.defaultPrevented).toBe(false);
  });
  it('focus on editable input releases the native gate even if reader selection remains', () => {
    render(<Harness />); select(); fireEvent.focusIn(screen.getByRole('textbox'));
    expect(set).toHaveBeenLastCalledWith({ target: 'menu', suppressed: false });
  });
  it('clear selection releases menu suppression immediately', () => {
    render(<Harness />); select(); window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event('selectionchange'));
    expect(set).toHaveBeenLastCalledWith({ target: 'menu', suppressed: false });
  });
  it('selection outside article never suppresses system menu', () => {
    render(<Harness />);
    const outside = document.createElement('p'); outside.textContent = 'outside'; document.body.append(outside);
    const range = document.createRange(); range.selectNodeContents(outside); window.getSelection()?.addRange(range);
    fireEvent(document, new Event('selectionchange')); expect(set).not.toHaveBeenCalled(); outside.remove();
  });
  it('unmount restores native menu without clearing selected text', () => {
    const result = render(<Harness />); fireEvent.pointerDown(screen.getByText('reader selected text'));
    result.unmount(); expect(set).toHaveBeenLastCalledWith({ target: 'menu', suppressed: false });
    act(() => vi.advanceTimersByTime(1000)); expect(set).toHaveBeenCalledTimes(2);
  });
  it('web and other platforms retain native context-menu behavior', () => {
    render(<Harness android={false} />); fireEvent.pointerDown(screen.getByText('reader selected text')); select();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(screen.getByText('reader selected text'), event);
    expect(event.defaultPrevented).toBe(false); expect(set).not.toHaveBeenCalled();
  });
});
