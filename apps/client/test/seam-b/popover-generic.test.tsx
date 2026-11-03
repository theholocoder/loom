import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { placePopover, POPOVER_MAX_HEIGHT, Select } from '../../src/renderer/Popover';

const VIEWPORT = { width: 800, height: 300 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('placing a popover', () => {
  it('opens below when it fits', () => {
    expect(placePopover({ top: 10, bottom: 34, left: 20 }, { width: 800, height: 600 }, { width: 200, height: 100 })).toEqual({ side: 'down', top: 38, left: 20, maxHeight: POPOVER_MAX_HEIGHT });
  });

  it('opens above, capped to the room there, when the trigger is near the bottom', () => {
    // Above: 260 - 4 (gap) - 8 (margin) = 248.
    expect(placePopover({ top: 260, bottom: 284, left: 20 }, VIEWPORT, { width: 200, height: 400 })).toEqual({ side: 'up', bottom: 44, left: 20, maxHeight: 248 });
  });

  it('stays inside the viewport horizontally', () => {
    expect(placePopover({ top: 10, bottom: 34, left: 700 }, VIEWPORT, { width: 360, height: 50 }).left).toBe(800 - 8 - 360);
    expect(placePopover({ top: 10, bottom: 34, left: -50 }, VIEWPORT, { width: 100, height: 50 }).left).toBe(8);
  });
});

describe('Select', () => {
  it('opens, moves with ArrowDown and picks with Enter; className lands on the trigger and popover', () => {
    const onChange = vi.fn();
    const options = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ];
    render(<Select label="Letter" value="a" options={options} onChange={onChange} className="custom" />);
    const trigger = screen.getByRole('button', { name: 'Letter' });
    expect(trigger.classList).toContain('pick');
    expect(trigger.classList).toContain('custom');
    expect(trigger.classList).toContain('select-field');
    expect(trigger.querySelector('svg.chev')).not.toBeNull();
    fireEvent.click(trigger);
    const [alpha, beta] = screen.getAllByRole('option');
    expect(document.activeElement).toBe(alpha);
    expect(screen.getByRole('listbox', { name: 'Letter' }).classList).toContain('custom');
    fireEvent.keyDown(alpha!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(beta);
    fireEvent.keyDown(beta!, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Select variants', () => {
  it('a compact Select still carries the chevron, without the field class', () => {
    render(<Select label="Tight" variant="compact" value="a" options={[{ value: 'a', label: 'Alpha' }]} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Tight' });
    expect(trigger.classList).toContain('select-compact');
    expect(trigger.classList).not.toContain('select-field');
    expect(trigger.querySelector('svg.chev')).not.toBeNull();
  });
});

describe('popover theme', () => {
  const dir = resolve(__dirname, '../../src/renderer');
  const css = readFileSync(resolve(dir, 'popover.css'), 'utf8');
  const rules = [...css.matchAll(/^([^{}\n]*\.popover[^{}\n]*)\{([^}]*)\}/gm)];

  it('colours popovers with the theme variables only', () => {
    expect(rules.length).toBeGreaterThan(0);
    const base = rules.find(([, selector]) => selector!.trim() === '.popover')![2]!;
    for (const variable of ['--panel2', '--line', '--text', '--shadow', '--radius']) expect(base).toContain(`var(${variable})`);
    expect(css).toMatch(/\.popover[^{]*:hover[^{]*\{[^}]*var\(--hover\)/);
    for (const [, , body] of rules) {
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      for (const [, prop, value] of body!.matchAll(/(?:^|;)\s*(color|background(?:-color)?|border(?:-color)?|box-shadow)\s*:\s*([^;]+)/g)) {
        if (!/^(none|0|transparent)$/.test(value!.trim())) expect(`${prop}: ${value}`).toMatch(/var\(--/);
      }
    }
  });

  it('keeps the generic popover rules out of styles.css', () => {
    const styles = readFileSync(resolve(dir, 'styles.css'), 'utf8');
    const selectors = [...styles.matchAll(/^([^{}\n]*popover[^{}\n]*)\{/gm)].map(([, selector]) => selector!.trim());
    const generic = selectors.filter((selector) => /(^|[^\w-])\.popover(?![\w.-])/.test(selector));
    expect(generic).toEqual([]);
  });
});
