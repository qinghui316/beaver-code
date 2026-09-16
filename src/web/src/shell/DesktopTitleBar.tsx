import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { fetchJson, postJson } from "../api.js";
import type { AppStatus } from "../types.js";
import type { DesktopMenuId, DesktopMenuOpenResult } from "../../../types/desktop-shell.js";

const MENU_LABELS: Record<DesktopMenuId, string> = {
  file: "文件",
  edit: "编辑",
  view: "视图",
  help: "帮助",
};

const MENU_ACCESS_KEYS: Record<string, DesktopMenuId> = {
  f: "file",
  e: "edit",
  v: "view",
  h: "help",
};

export function DesktopTitleBar({ onError }: { onError: (message: string) => void }): ReactElement | null {
  const [menus, setMenus] = useState<DesktopMenuId[] | null>(null);
  const [openMenu, setOpenMenu] = useState<DesktopMenuId | null>(null);
  const buttonRefs = useRef(new Map<DesktopMenuId, HTMLButtonElement>());

  useEffect(() => {
    let current = true;
    void fetchJson<AppStatus>("/api/app/status").then((status) => {
      if (current && status.desktopShell?.available) setMenus(status.desktopShell.menus);
    }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!menus) return;
    const handleAccessKey = (event: globalThis.KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const menuId = MENU_ACCESS_KEYS[event.key.toLowerCase()];
      if (!menuId || !menus.includes(menuId)) return;
      event.preventDefault();
      buttonRefs.current.get(menuId)?.click();
    };
    window.addEventListener("keydown", handleAccessKey);
    return () => window.removeEventListener("keydown", handleAccessKey);
  }, [menus]);

  if (!menus) return null;
  const availableMenus = menus;

  async function requestOpen(menuId: DesktopMenuId): Promise<void> {
    if (openMenu) return;
    const button = buttonRefs.current.get(menuId);
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setOpenMenu(menuId);
    try {
      const result = await postJson<DesktopMenuOpenResult>("/api/desktop/menu/open", {
        menuId,
        anchor: { x: Math.round(rect.left), y: Math.round(rect.bottom) },
      });
      if (!result.opened) onError(result.error || "菜单未能打开。");
    } catch {
      onError("菜单未能打开，请重试。");
    } finally {
      setOpenMenu(null);
      button.focus();
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void requestOpen(availableMenus[index]!);
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % availableMenus.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + availableMenus.length) % availableMenus.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = availableMenus.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    buttonRefs.current.get(availableMenus[nextIndex]!)?.focus();
  }

  return <header className="desktop-title-bar" data-testid="desktop-title-bar">
    <nav className="desktop-title-menu" aria-label="应用菜单" role="menubar">
      {availableMenus.map((menuId, index) => <button
        key={menuId}
        ref={(node) => {
          if (node) buttonRefs.current.set(menuId, node);
          else buttonRefs.current.delete(menuId);
        }}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={openMenu === menuId}
        className="desktop-title-menu-button"
        onClick={() => void requestOpen(menuId)}
        onKeyDown={(event) => handleMenuKeyDown(event, index)}
      >{MENU_LABELS[menuId]}</button>)}
    </nav>
    <div className="desktop-title-drag-region" aria-hidden="true" />
  </header>;
}
