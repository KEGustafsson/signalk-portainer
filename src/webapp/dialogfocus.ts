import { useEffect, useRef, type RefObject } from 'react';

/**
 * The focus behaviour every dialog in this panel needs.
 *
 * Two things, and neither is optional for anyone driving this from a keyboard:
 *
 * The panel is a guest inside the Signal K admin UI, so `aria-modal` alone
 * traps nothing — Tab walks straight out of the dialog and into the host page
 * behind the scrim, where the operator is tabbing through controls they cannot
 * see. And closing a dialog that moved focus into itself drops focus back to
 * `<body>`, so the next Tab starts at the top of the admin UI rather than at
 * the row the operator pressed a button on.
 *
 * Written once here rather than five times: the dialogs differ in what they
 * focus first, and in nothing else.
 */

/**
 * What can hold focus, in document order.
 *
 * Deliberately not filtered on visibility: `offsetParent` and
 * `getBoundingClientRect` both report nothing in jsdom, so a filter would
 * quietly turn the trap off in the tests that are supposed to prove it works.
 * Everything inside a dialog is on screen anyway — the dialog is the thing on
 * screen.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Traps Tab inside the dialog and gives focus back when it closes.
 *
 * Returns the ref to put on the dialog's outermost element. `initial` is what
 * to focus on the way in — every dialog here points it at Close or Cancel, so
 * a stray Enter does nothing — and the first focusable element is used when it
 * holds nothing.
 */
export function useDialogFocus(
  initial?: RefObject<HTMLElement | null>,
): RefObject<HTMLDivElement | null> {
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const returnTo = document.activeElement;
    const element = container.current;
    const first = initial?.current ?? (element ? focusableWithin(element)[0] : undefined);
    first?.focus();

    return () => {
      // Only if it is still in the document: the row that opened this dialog
      // can have been replaced by a poll, or the whole panel torn down, and
      // focusing a detached node silently drops focus on `<body>` — the very
      // thing this is here to prevent.
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
    // Deliberately once: `initial` is a ref, and re-running this would drag
    // focus back to Close from wherever the operator had moved it.
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const element = container.current;
      if (!element) return;
      const focusable = focusableWithin(element);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !element.contains(active)) {
        // Focus escaped some other way — a click on the host page behind the
        // scrim — and the next Tab brings it back rather than walking on.
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return container;
}
