import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Download } from "lucide-react";
import { useDesktopUpdateOffer } from "./DesktopUpdateOfferContext.js";

interface PopoverPosition {
  left: number;
  top: number;
  arrowLeft: number;
  placement: "top" | "bottom";
}

export function DesktopUpdateDock({ className = "", displayWhen = "always" }: { className?: string; displayWhen?: "always" | "desktop" | "mobile" }): ReactElement | null {
  const surface = useDesktopUpdateOffer();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusPanelOnOpenRef = useRef(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 720px)").matches : false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 720px)");
    const update = (): void => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!surface.view.expanded) {
      setPosition(null);
      return;
    }
    const updatePosition = (): void => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const viewportPadding = 12;
      const gap = 12;
      const left = clamp(triggerRect.right - panelRect.width, viewportPadding, window.innerWidth - panelRect.width - viewportPadding);
      const topCandidate = triggerRect.top - panelRect.height - gap;
      const placement = topCandidate >= viewportPadding ? "top" : "bottom";
      const unclampedTop = placement === "top" ? topCandidate : triggerRect.bottom + gap;
      const top = clamp(unclampedTop, viewportPadding, window.innerHeight - panelRect.height - viewportPadding);
      const arrowLeft = clamp(triggerRect.left + triggerRect.width / 2 - left, 24, panelRect.width - 24);
      setPosition({ left, top, arrowLeft, placement });
    };
    updatePosition();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updatePosition) : null;
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [surface.view.expanded]);

  useEffect(() => {
    if (!surface.view.expanded) return;
    if (focusPanelOnOpenRef.current) {
      focusPanelOnOpenRef.current = false;
      panelRef.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      surface.actions.dismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      surface.actions.dismiss();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [surface.actions, surface.view.expanded]);

  const activeHost = displayWhen === "always" || (displayWhen === "mobile" ? narrow : !narrow);
  if (!activeHost || !surface.view.available || !surface.view.version) return null;
  const panelId = "desktop-update-popover";
  const popoverStyle = position ? { left: position.left, top: position.top } : undefined;

  return <div className={`desktop-update-dock ${className}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="desktop-update-trigger"
      aria-label="更新"
      title="更新已准备好"
      aria-expanded={surface.view.expanded}
      aria-controls={surface.view.expanded ? panelId : undefined}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !surface.view.expanded) focusPanelOnOpenRef.current = true;
      }}
      onClick={() => surface.view.expanded ? surface.actions.dismiss() : surface.actions.open()}
    >
      <Download size={15} aria-hidden="true" />
      <span className="sr-only">更新</span>
    </button>
    {surface.view.expanded && typeof document !== "undefined" ? createPortal(
      <div
        ref={panelRef}
        id={panelId}
        className="desktop-update-popover"
        data-placement={position?.placement ?? "top"}
        data-positioned={position ? "true" : "false"}
        role="dialog"
        aria-label={`Beaver Code ${surface.view.version} 更新`}
        style={popoverStyle}
      >
        <span className="desktop-update-popover-arrow" aria-hidden="true" style={position ? { left: position.arrowLeft } : undefined} />
        <div className="desktop-update-popover-heading">
          <span className="desktop-update-popover-icon"><Download size={19} aria-hidden="true" /></span>
          <div><strong>Beaver Code {surface.view.version} 已准备好</strong><p>更新已下载，重新启动后即可使用。</p></div>
        </div>
        {surface.view.failure ? <p className="desktop-update-popover-error" role="alert">{surface.view.failure}</p> : null}
        <button type="button" className="desktop-update-install" disabled={surface.view.submitting} onClick={() => void surface.actions.install()}>
          {surface.view.submitting ? "正在准备…" : "重新启动并更新"}
        </button>
        {surface.view.releaseUrl ? <button type="button" className="desktop-update-release-notes" onClick={surface.actions.openReleaseNotes}>查看更新说明</button> : null}
      </div>,
      document.body,
    ) : null}
  </div>;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
