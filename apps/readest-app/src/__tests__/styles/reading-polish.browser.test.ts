import { afterEach, describe, expect, it } from 'vitest';
import '@/styles/globals.css';
import '@/styles/reader-polish.css';

const mountPanel = () => {
  const el = document.createElement('div');
  el.className = 'reading-panel';
  el.dataset['state'] = 'closed';
  el.style.height = '240px';
  document.body.appendChild(el);
  return el;
};

// Seek real CSS transitions deterministically rather than sleeping and relying
// on a background tab's throttled frame clock.
const settle = (el: HTMLElement) => {
  getComputedStyle(el).opacity;
  el.getAnimations().forEach((animation) => animation.finish());
  return getComputedStyle(el);
};

afterEach(() => {
  document.querySelectorAll('.reading-panel').forEach((el) => el.remove());
  delete document.documentElement.dataset['eink'];
});

describe('reading panel compositor motion', () => {
  it('finishes open and closed without changing the measurable panel height', () => {
    const el = mountPanel();
    expect(settle(el).visibility).toBe('hidden');
    const height = el.offsetHeight;
    el.dataset['state'] = 'open';
    expect(settle(el).opacity).toBe('1');
    expect(getComputedStyle(el).visibility).toBe('visible');
    el.dataset['state'] = 'closed';
    expect(settle(el).opacity).toBe('0');
    expect(getComputedStyle(el).visibility).toBe('hidden');
    expect(el.offsetHeight).toBe(height);
  });

  it('keeps painting during exit and reverses a half-finished transition', () => {
    const el = mountPanel();
    settle(el);
    el.dataset['state'] = 'open';
    settle(el);
    el.dataset['state'] = 'closed';
    getComputedStyle(el).opacity;
    const transitions = el.getAnimations();
    expect(transitions.length).toBeGreaterThan(0);
    transitions.forEach((animation) => {
      animation.pause();
      animation.currentTime = 90;
    });
    const halfway = getComputedStyle(el);
    expect(halfway.visibility).toBe('visible');
    expect(Number(halfway.opacity)).toBeGreaterThan(0);
    expect(Number(halfway.opacity)).toBeLessThan(1);
    el.dataset['state'] = 'open';
    expect(settle(el).opacity).toBe('1');
    expect(getComputedStyle(el).visibility).toBe('visible');
  });

  it('disables interpolation on e-ink while preserving open/closed state', () => {
    document.documentElement.dataset['eink'] = 'true';
    const el = mountPanel();
    expect(settle(el).transitionProperty).toBe('none');
    el.dataset['state'] = 'open';
    expect(settle(el).opacity).toBe('1');
    expect(getComputedStyle(el).transform).toBe('none');
    expect(el.getAnimations()).toHaveLength(0);
    el.dataset['state'] = 'closed';
    expect(settle(el).visibility).toBe('hidden');
  });
});
