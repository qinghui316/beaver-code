export const DESKTOP_MENU_IDS = ["file", "edit", "view", "help"] as const;

export type DesktopMenuId = typeof DESKTOP_MENU_IDS[number];

export interface DesktopMenuOpenRequest {
  menuId: DesktopMenuId;
  anchor: {
    x: number;
    y: number;
  };
}

export interface DesktopMenuOpenResult {
  opened: boolean;
  error?: string;
}

export interface DesktopShellCapability {
  available: true;
  menus: DesktopMenuId[];
}

export function isDesktopMenuId(value: unknown): value is DesktopMenuId {
  return typeof value === "string" && (DESKTOP_MENU_IDS as readonly string[]).includes(value);
}

export function isDesktopMenuOpenRequest(value: unknown): value is DesktopMenuOpenRequest {
  if (!isRecord(value) || !isDesktopMenuId(value.menuId) || !isRecord(value.anchor)) return false;
  return isMenuCoordinate(value.anchor.x) && isMenuCoordinate(value.anchor.y);
}

function isMenuCoordinate(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 32_768;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
