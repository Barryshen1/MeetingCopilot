import React, { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface InWindowSelectOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

export interface InWindowSelectProps {
  value: string;
  options: InWindowSelectOption[];
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** Wrap through enabled options, starting *after* the supplied index. */
export function nextEnabledOptionIndex(
  options: InWindowSelectOption[],
  from: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;
  for (let step = 1; step <= options.length; step += 1) {
    const index = (from + direction * step + options.length * 2) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

/** Keep the menu inside the protected renderer window, including near its edges. */
export function calculateMenuPosition(
  trigger: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  contentHeight: number,
): MenuPosition {
  const margin = 8;
  const gap = 4;
  const width = Math.min(Math.max(trigger.width, 180), Math.max(0, viewportWidth - margin * 2));
  const left = Math.max(margin, Math.min(trigger.left, viewportWidth - margin - width));
  const roomBelow = Math.max(0, viewportHeight - trigger.bottom - gap - margin);
  const roomAbove = Math.max(0, trigger.top - gap - margin);
  const wantedHeight = Math.min(256, contentHeight);
  const above = roomBelow < Math.min(wantedHeight, 120) && roomAbove > roomBelow;
  const maxHeight = Math.min(256, above ? roomAbove : roomBelow);
  const visibleHeight = Math.min(contentHeight, maxHeight);
  const rawTop = above ? trigger.top - gap - visibleHeight : trigger.bottom + gap;
  const top = Math.max(margin, Math.min(rawTop, viewportHeight - margin - visibleHeight));
  return { left, top, width, maxHeight };
}

/**
 * A select whose popup stays in the Electron renderer. Native macOS select
 * menus are separate OS surfaces and can appear in screen sharing even when
 * Electron protects the application window.
 */
export function InWindowSelect({
  value,
  options,
  onChange,
  id,
  className,
  disabled = false,
  ariaLabel,
}: InWindowSelectProps) {
  const generatedId = useId().replace(/:/g, '');
  const controlId = id ?? `in-window-select-${generatedId}`;
  const listboxId = `${controlId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : value;
  const hasEnabledOption = options.some((option) => !option.disabled);
  const isDisabled = disabled || !hasEnabledOption;

  const openMenu = () => {
    if (isDisabled) return;
    setActiveIndex(
      selectedIndex >= 0 && !options[selectedIndex].disabled
        ? selectedIndex
        : nextEnabledOptionIndex(options, -1, 1),
    );
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (option.value !== value) onChange(option.value);
  };

  useEffect(() => {
    if (disabled || !hasEnabledOption) setOpen(false);
  }, [disabled, hasEnabledOption]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const bounds = trigger.getBoundingClientRect();
      if (bounds.bottom < 0 || bounds.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      setPosition(calculateMenuPosition(bounds, window.innerWidth, window.innerHeight, menu.scrollHeight));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    // Capture scroll on the settings pane and any other scrollable ancestor.
    window.addEventListener('scroll', updatePosition, true);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePosition) : null;
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      observer?.disconnect();
    };
  }, [open, options.length]);

  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    const active = document.getElementById(`${listboxId}-option-${activeIndex}`);
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, listboxId]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) {
          openMenu();
        } else {
          const next = nextEnabledOptionIndex(options, activeIndex, event.key === 'ArrowDown' ? 1 : -1);
          if (next >= 0) setActiveIndex(next);
        }
        break;
      }
      case 'Home':
      case 'End': {
        event.preventDefault();
        if (!open) openMenu();
        const next = nextEnabledOptionIndex(options, event.key === 'Home' ? -1 : 0, event.key === 'Home' ? 1 : -1);
        if (next >= 0) setActiveIndex(next);
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (open) choose(activeIndex);
        else openMenu();
        break;
      }
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={controlId}
        className={`in-window-select${className ? ` ${className}` : ''}`}
        disabled={isDisabled}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="in-window-select-label">{selectedLabel}</span>
        <span className="in-window-select-chevron" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="in-window-select-menu"
          role="listbox"
          aria-label={ariaLabel}
          style={position ?? { visibility: 'hidden' }}
        >
          {options.map((option, index) => (
            <Fragment key={`${option.value}-${index}`}>
              {option.group && (index === 0 || options[index - 1].group !== option.group) && (
                <div className="in-window-select-group" role="presentation">{option.group}</div>
              )}
              <div
                id={`${listboxId}-option-${index}`}
                className={`in-window-select-option${index === activeIndex ? ' is-active' : ''}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span className="in-window-select-option-label">{option.label}</span>
                {option.value === value && <span className="in-window-select-check" aria-hidden="true">✓</span>}
              </div>
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
