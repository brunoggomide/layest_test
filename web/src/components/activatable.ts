import type { KeyboardEvent } from 'react';

/** Makes a clickable table row reachable and operable from the keyboard, like the button it stands in for. */
export function activatable(onActivate: () => void): { tabIndex: number; role: string; onClick(): void; onKeyDown(event: KeyboardEvent): void } {
  return {
    tabIndex: 0,
    role: 'button',
    onClick: onActivate,
    onKeyDown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onActivate();
    },
  };
}
