import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  InWindowSelect,
  calculateMenuPosition,
  nextEnabledOptionIndex,
  type InWindowSelectOption,
} from '../src/components/InWindowSelect';

const options: InWindowSelectOption[] = [
  { value: 'general', label: '普通' },
  { value: 'locked', label: 'Unavailable', disabled: true },
  { value: 'coding', label: 'Coding Test' },
];

describe('InWindowSelect', () => {
  it('renders an accessible renderer-owned trigger without a native select', () => {
    const html = renderToStaticMarkup(
      <InWindowSelect
        id="answer-mode"
        value="coding"
        options={options}
        onChange={() => {}}
        ariaLabel="回答模式"
      />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="回答模式"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Coding Test');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('title=');
    // The renderer button stays in the normal tab order.
    expect(html).not.toContain('tabindex="-1"');
  });

  it('uses real button disabled semantics when there is no selectable option', () => {
    const disabled = renderToStaticMarkup(
      <InWindowSelect value="locked" options={[options[1]]} onChange={() => {}} />,
    );
    expect(disabled).toContain('disabled=""');
    expect(disabled).toContain('aria-expanded="false"');
  });

  it('wraps keyboard navigation and skips disabled options', () => {
    expect(nextEnabledOptionIndex(options, 0, 1)).toBe(2);
    expect(nextEnabledOptionIndex(options, 2, 1)).toBe(0);
    expect(nextEnabledOptionIndex(options, 2, -1)).toBe(0);
    expect(nextEnabledOptionIndex(options, 0, -1)).toBe(2);
    expect(nextEnabledOptionIndex([{ value: 'x', label: 'X', disabled: true }], 0, 1)).toBe(-1);
  });

  it('keeps popup bounds within the renderer viewport', () => {
    const below = calculateMenuPosition(
      { left: 350, top: 20, right: 390, bottom: 44, width: 40 },
      400, 300, 180,
    );
    expect(below.width).toBe(180);
    expect(below.left).toBe(212);
    expect(below.top).toBe(48);
    expect(below.top + below.maxHeight).toBeLessThanOrEqual(292);

    const above = calculateMenuPosition(
      { left: 10, top: 240, right: 110, bottom: 264, width: 100 },
      400, 300, 180,
    );
    expect(above.top).toBeLessThan(240);
    expect(above.left).toBeGreaterThanOrEqual(8);
    expect(above.top + above.maxHeight).toBeLessThanOrEqual(292);
  });
});
