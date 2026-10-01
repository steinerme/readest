import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavigationPanel } from '@/app/reader/components/footerbar/NavigationPanel';
import { FontLayoutPanel } from '@/app/reader/components/footerbar/FontLayoutPanel';
import { ColorPanel } from '@/app/reader/components/footerbar/ColorPanel';

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobile: true } }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => null,
    getViewSettings: () => ({}),
    setHoveredBookKey: vi.fn(),
  }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: { screenBrightness: 50 } }),
}));
vi.mock('@/store/deviceStore', () => ({ useDeviceControlStore: () => ({}) }));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ themeMode: 'light', themeColor: 'gray', isDarkMode: false }),
}));
vi.mock('@/helpers/settings', () => ({ saveViewSettings: vi.fn(), saveSysSettings: vi.fn() }));
vi.mock('@/components/Slider', () => ({ default: () => <input type='range' /> }));
vi.mock('@/components/Button', () => ({
  default: ({ label }: { label: string }) => <button type='button'>{label}</button>,
}));
vi.mock('@/app/reader/components/footerbar/PageJumpInput', () => ({ default: () => null }));

afterEach(cleanup);

const renderPanel = (kind: string, actionTab: string) => {
  const common = { actionTab, bottomOffset: '64px', forceMobileLayout: true };
  if (kind === 'font') return <FontLayoutPanel {...common} bookKey='book-1' marginIconSize={20} />;
  if (kind === 'color') return <ColorPanel {...common} />;
  return (
    <NavigationPanel
      {...common}
      bookKey='book-1'
      progressFraction={0.4}
      progressValid={true}
      sliderHeight={28}
      navigationHandlers={{
        onPrevPage: vi.fn(),
        onNextPage: vi.fn(),
        onPrevSection: vi.fn(),
        onNextSection: vi.fn(),
        onGoBack: vi.fn(),
        onGoForward: vi.fn(),
        onProgressChange: vi.fn(),
      }}
    />
  );
};

describe.each(['font', 'color', 'progress'])('%s reading panel', (kind) => {
  it('retains its mounted content and height classes while closing', () => {
    const { container, rerender } = render(renderPanel(kind, kind));
    const panel = container.querySelector('.reading-panel')!;
    const firstControl = panel.querySelector('input,button');
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(panel.hasAttribute('inert')).toBe(false);
    rerender(renderPanel(kind, ''));
    expect(container.querySelector('.reading-panel')).toBe(panel);
    expect(panel.querySelector('input,button')).toBe(firstControl);
    expect(panel.getAttribute('data-state')).toBe('closed');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.classList.contains('pb-4')).toBe(true);
    expect(panel.classList.contains('pt-8')).toBe(true);
    expect(panel.className).not.toMatch(/transition-all|invisible|translate-y-full/);
  });

  it('reverses a rapid close/reopen without unmounting or a timer', () => {
    const { container, rerender } = render(renderPanel(kind, kind));
    const panel = container.querySelector('.reading-panel')!;
    rerender(renderPanel(kind, ''));
    rerender(renderPanel(kind, kind));
    expect(container.querySelector('.reading-panel')).toBe(panel);
    expect(panel.getAttribute('data-state')).toBe('open');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.getAttribute('aria-hidden')).toBe('false');
  });
});
