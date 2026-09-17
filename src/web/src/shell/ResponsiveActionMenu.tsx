import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { DialogSurface } from "../presentation/DialogSurface.js";

export interface ResponsiveActionMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onSelect: () => void;
}

function useActionSheetLayout(): boolean {
  const query = "(max-width: 720px), (pointer: coarse)";
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return matches;
}

export function ResponsiveActionMenu({ open, onOpenChange, trigger, triggerLabel, triggerClassName = "", menuLabel, items }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  triggerLabel: string;
  triggerClassName?: string;
  menuLabel: string;
  items: readonly ResponsiveActionMenuItem[];
}): ReactElement {
  const actionSheet = useActionSheetLayout();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const select = (item: ResponsiveActionMenuItem) => {
    if (item.disabled) return;
    onOpenChange(false);
    item.onSelect();
  };
  const triggerButton = (
    <button
      ref={triggerRef}
      type="button"
      className={`navigation-menu-trigger ${triggerClassName}`.trim()}
      aria-label={triggerLabel}
      title={triggerLabel}
      onClick={actionSheet || (typeof window !== "undefined" && typeof window.PointerEvent !== "function") ? () => onOpenChange(!open) : undefined}
    >
      {trigger}
    </button>
  );
  if (actionSheet) return (
    <>
      {triggerButton}
      <DialogSurface open={open} onClose={() => onOpenChange(false)} ariaLabel={menuLabel} panelClassName="responsive-action-sheet" returnFocusRef={triggerRef} portal>
        <div className="responsive-action-sheet-handle" aria-hidden="true" />
        <p className="responsive-action-sheet-title">{menuLabel}</p>
        {items.map((item) => <button
          type="button"
          key={item.id}
          className={`responsive-action-item${item.danger ? " danger" : ""}`}
          disabled={item.disabled}
          title={item.disabledReason}
          onClick={() => select(item)}
        >{item.icon}{item.label}</button>)}
      </DialogSurface>
    </>
  );
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{triggerButton}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="navigation-action-menu" side="right" align="start" sideOffset={6} collisionPadding={12} aria-label={menuLabel}>
          {items.map((item) => <DropdownMenu.Item
            key={item.id}
            className={`navigation-action-menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            title={item.disabledReason}
            onSelect={() => select(item)}
          >{item.icon}{item.label}</DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
