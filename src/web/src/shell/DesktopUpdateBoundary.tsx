import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { rendererUpdateParticipants } from "../controllers/RendererUpdateParticipants.js";
import { DesktopUpdateOfferContext, type DesktopUpdateOfferSurface } from "./DesktopUpdateOfferContext.js";

export function DesktopUpdateBoundary({ children }: { children: ReactNode }) {
  const [frozen, setFrozen] = useState(false);
  const [failed, setFailed] = useState(false);
  const notice = useRef<HTMLDialogElement>(null);
  const focusBeforeUpdate = useRef<HTMLElement | null>(null);
  const [offer, setOffer] = useState<{ offerId: string; version: string; releaseUrl: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [choiceFailure, setChoiceFailure] = useState<string | null>(null);
  const autoOpenedOffers = useRef(new Set<string>());
  const currentOfferId = useRef<string | null>(null);
  const choosingOfferId = useRef<string | null>(null);
  const choiceEpoch = useRef(0);
  useLayoutEffect(() => {
    if (frozen && notice.current && !notice.current.open) notice.current.showModal();
    if (!frozen) focusBeforeUpdate.current?.focus();
  }, [frozen]);
  useEffect(() => {
    let disposed = false;
    let events: EventSource | null = null;
    let activeUpdate: string | null = null;
    let connectionId: string | null = null;
    let epoch = 0;
    const release = (): void => {
      activeUpdate = null;
      setFrozen(false);
    };
    void fetch("/api/app/status").then(async (response) => {
      if (!response.ok) return;
      const status = await response.json() as { desktopUpdates?: boolean };
      if (disposed || !status.desktopUpdates) return;
      events = new EventSource("/api/desktop/update/events");
      events.addEventListener("connected", (event) => {
        const value = JSON.parse((event as MessageEvent).data) as { connectionId?: string };
        connectionId = value.connectionId ?? null;
      });
      events.addEventListener("offer", (event) => {
        const value = JSON.parse((event as MessageEvent).data) as typeof offer;
        if (disposed) return;
        if (!value) {
          choiceEpoch.current += 1;
          currentOfferId.current = null;
          choosingOfferId.current = null;
          setOffer(null);
          setExpanded(false);
          setChoosing(false);
          setChoiceFailure(null);
          return;
        }
        const sameOffer = currentOfferId.current === value.offerId;
        currentOfferId.current = value.offerId;
        if (!sameOffer) {
          choiceEpoch.current += 1;
          choosingOfferId.current = null;
          setChoosing(false);
          setChoiceFailure(null);
        }
        setOffer(value);
        if (!autoOpenedOffers.current.has(value.offerId)) {
          autoOpenedOffers.current.add(value.offerId);
          setExpanded(true);
        }
      });
      events.addEventListener("update", (event) => {
        const myEpoch = ++epoch;
        void (async () => {
          const value = JSON.parse((event as MessageEvent).data) as {
            requestId?: string; connectionId?: string;
            action?: "prepare" | "confirm" | "cancel";
            identity?: { updateId?: string };
          };
          const updateId = value.identity?.updateId;
          if (!updateId || !value.requestId || value.connectionId !== connectionId || disposed) return;
          let ok = false;
          try {
            if (value.action === "cancel") {
              if (activeUpdate === updateId) {
                rendererUpdateParticipants.cancel(updateId);
                release();
              }
              ok = true;
            } else if (value.action === "prepare") {
              activeUpdate = updateId;
              focusBeforeUpdate.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              flushSync(() => { setFrozen(true); setFailed(false); setExpanded(false); });
              await rendererUpdateParticipants.prepare(updateId);
              ok = activeUpdate === updateId && rendererUpdateParticipants.confirm(updateId);
            } else if (value.action === "confirm") {
              ok = activeUpdate === updateId && rendererUpdateParticipants.confirm(updateId);
            }
          } catch { ok = false; }
          if (disposed || epoch !== myEpoch) return;
          const ack = await fetch("/api/desktop/update/ack", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: value.requestId, connectionId, ok }),
          });
          if (!ack.ok && activeUpdate) setFailed(true);
        })().catch(() => { if (!disposed && activeUpdate) setFailed(true); });
      });
      events.onerror = () => {
        epoch += 1;
        if (activeUpdate) setFailed(true);
      };
    }).catch(() => { /* Update discovery must not prevent normal Web startup. */ });
    return () => {
      disposed = true;
      epoch += 1;
      choiceEpoch.current += 1;
      currentOfferId.current = null;
      choosingOfferId.current = null;
      events?.close();
    };
  }, []);

  const install = useCallback(async (): Promise<void> => {
    if (!offer || choosingOfferId.current) return;
    const selectedOffer = offer;
    const requestEpoch = ++choiceEpoch.current;
    choosingOfferId.current = selectedOffer.offerId;
    setChoosing(true);
    setChoiceFailure(null);
    try {
      const response = await fetch("/api/desktop/update/choice", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ offerId: selectedOffer.offerId, action: "install" }),
      });
      if (!response.ok) throw new Error("choice rejected");
      if (choiceEpoch.current !== requestEpoch || currentOfferId.current !== selectedOffer.offerId) return;
      currentOfferId.current = null;
      choosingOfferId.current = null;
      setOffer(null);
      setExpanded(false);
    } catch {
      if (choiceEpoch.current !== requestEpoch || currentOfferId.current !== selectedOffer.offerId) return;
      choosingOfferId.current = null;
      setChoosing(false);
      setExpanded(true);
      setChoiceFailure("更新暂未开始，请重试。");
    }
  }, [offer]);

  const offerSurface = useMemo<DesktopUpdateOfferSurface>(() => ({
    view: {
      available: Boolean(offer),
      version: offer?.version ?? null,
      releaseUrl: offer?.releaseUrl ?? null,
      expanded: Boolean(offer) && expanded && !frozen,
      submitting: choosing,
      failure: choiceFailure,
    },
    actions: {
      open: () => { if (offer) setExpanded(true); },
      dismiss: () => setExpanded(false),
      openReleaseNotes: () => {
        if (!offer?.releaseUrl) return;
        setExpanded(false);
        window.open(offer.releaseUrl, "_blank", "noopener,noreferrer");
      },
      install,
    },
  }), [choiceFailure, choosing, expanded, frozen, install, offer]);

  return <>
    <DesktopUpdateOfferContext.Provider value={offerSurface}>
      <div inert={frozen} aria-busy={frozen || undefined}>{children}</div>
    </DesktopUpdateOfferContext.Provider>
    <span className="sr-only" role="status" aria-live="polite">{offer ? `Beaver Code ${offer.version} 更新已准备好` : ""}</span>
    {frozen && <dialog ref={notice} className="desktop-update-notice" aria-labelledby="desktop-update-title" aria-modal="true"
      onCancel={(event) => event.preventDefault()}>
      <strong id="desktop-update-title" role={failed ? "alert" : "status"}>{failed ? "更新暂未完成" : "正在保存并更新…"}</strong>
      <p>{failed ? "请在帮助菜单中查看诊断，或重新启动工作台。" : "保存完成后将自动重启 Beaver Code。"}</p>
    </dialog>}
  </>;
}
