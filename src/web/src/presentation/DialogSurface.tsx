import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useModalDialogFocus } from "./useModalDialogFocus.js";

export function DialogSurface({
  open,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  overlayClassName = "",
  panelClassName = "",
  returnFocusRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  overlayClassName?: string;
  panelClassName?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}): ReactNode {
  const dialogRef = useModalDialogFocus(open, returnFocusRef);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className={`settings-overlay ${overlayClassName}`.trim()}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
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
}
