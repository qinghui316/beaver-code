import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useModalDialogFocus(open: boolean, returnFocusRef?: RefObject<HTMLElement | null>): RefObject<HTMLElement | null> {
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
    const focusInitial = () => (dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusable()[0] ?? dialog).focus();
    focusInitial();
    const focusTimer = window.setTimeout(focusInitial, 0);

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeIndex = active ? items.indexOf(active) : -1;
      if (!active || !dialog.contains(active) || activeIndex === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", trapFocus);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", trapFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, returnFocusRef]);

  return dialogRef;
}
