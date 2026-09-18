import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useModalDialogFocus } from "./useModalDialogFocus.js";

export function DialogSurface({
  open,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  overlayClassName = "",
  panelClassName = "",
  returnFocusRef,
  dismissible = true,
  portal = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  overlayClassName?: string;
  panelClassName?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
  portal?: boolean;
  children: ReactNode;
}): ReactNode {
  const dialogRef = useModalDialogFocus(open, returnFocusRef);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dismissible, open]);

  if (!open) return null;
  const surface = (
    <div
      className={`dialog-overlay ${overlayClassName}`.trim()}
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <section
        ref={dialogRef}
        className={panelClassName}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
  return portal && typeof document !== "undefined" ? createPortal(surface, document.body) : surface;
}
