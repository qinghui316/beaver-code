import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { rendererUpdateParticipants } from "../controllers/RendererUpdateParticipants.js";
import { DesktopUpdateOfferContext, type DesktopUpdateOfferSurface } from "./DesktopUpdateOfferContext.js";
import { DesktopReleaseNotes } from "./DesktopReleaseNotes.js";
import { isDesktopUpdateActivity, type DesktopReleaseNotes as ReleaseNotes, type DesktopUpdateActivity, type DesktopUpdateOffer } from "../../../types/workbench-update.js";

export function DesktopUpdateBoundary({ children }: { children: ReactNode }) {
  const [frozen, setFrozen] = useState(false);
  const [failed, setFailed] = useState(false);
  const notice = useRef<HTMLDialogElement>(null);
  const focusBeforeUpdate = useRef<HTMLElement | null>(null);
  const [offer, setOffer] = useState<DesktopUpdateOffer | null>(null);
  const [activity, setActivity] = useState<DesktopUpdateActivity | null>(null);
  const activityRef = useRef<DesktopUpdateActivity | null>(null);
  const [installedNotes, setInstalledNotes] = useState<ReleaseNotes | null>(null);
  const [installedFailure, setInstalledFailure] = useState(false);
  const installedDialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [choiceFailure, setChoiceFailure] = useState<string | null>(null);
  const autoOpenedAttempts = useRef(new Set<string>());
  const currentAttemptId = useRef<string | null>(null);
  const currentOfferId = useRef<string | null>(null);
  const choosingOfferId = useRef<string | null>(null);
  const choiceEpoch = useRef(0);
  useLayoutEffect(() => {
    if (frozen && notice.current && !notice.current.open) notice.current.showModal();
    if (!frozen) focusBeforeUpdate.current?.focus();
  }, [frozen]);
  useLayoutEffect(() => {
    if (installedNotes && !frozen && installedDialog.current && !installedDialog.current.open) {
      installedDialog.current.showModal();
    }
    if (frozen && installedDialog.current?.open) installedDialog.current.close();
  }, [installedNotes, frozen]);
  useEffect(() => {
    let disposed = false;
    let events: EventSource | null = null;
    let activeUpdate: string | null = null;
    let shutdownExpected = false;
    let connectionId: string | null = null;
    let epoch = 0;
    const release = (): void => {
      activeUpdate = null;
      shutdownExpected = false;
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
        const value = JSON.parse((event as MessageEvent).data) as DesktopUpdateOffer | null;
        if (disposed) return;
        if (!value) {
          currentOfferId.current = null;
          setOffer(null);
          return;
        }
        if (activityRef.current?.phase !== "ready" || activityRef.current.attemptId !== value.offerId
          || activityRef.current.version !== value.version) return;
        const sameOffer = currentOfferId.current === value.offerId;
        currentOfferId.current = value.offerId;
        if (!sameOffer) {
          choiceEpoch.current += 1;
          choosingOfferId.current = null;
          setChoosing(false);
          setChoiceFailure(null);
        }
        setOffer(value);
        if (!autoOpenedAttempts.current.has(value.offerId)) {
          autoOpenedAttempts.current.add(value.offerId);
          setExpanded(true);
        }
      });
      events.addEventListener("activity", (event) => {
        const value = JSON.parse((event as MessageEvent).data) as DesktopUpdateActivity | null;
        if (disposed || (value !== null && !isDesktopUpdateActivity(value))) return;
        if (!value) {
          activityRef.current = null;
          currentAttemptId.current = null;
          currentOfferId.current = null;
          choiceEpoch.current += 1;
          choosingOfferId.current = null;
          setActivity(null);
          setOffer(null);
          setExpanded(false);
          setChoosing(false);
          setChoiceFailure(null);
          return;
        }
        if (currentAttemptId.current !== value.attemptId) {
          currentAttemptId.current = value.attemptId;
          choiceEpoch.current += 1;
          choosingOfferId.current = null;
          currentOfferId.current = null;
          setOffer(null);
          setChoosing(false);
          setChoiceFailure(null);
        }
        activityRef.current = value;
        setActivity(value);
        if (activeUpdate && value.phase === "installing") {
          shutdownExpected = true;
          setFailed(false);
        } else if (activeUpdate && value.phase === "failed") {
          setFailed(true);
        }
        if (value.phase !== "ready") {
          currentOfferId.current = null;
          setOffer(null);
        }
        if (!autoOpenedAttempts.current.has(value.attemptId)) {
          autoOpenedAttempts.current.add(value.attemptId);
          setExpanded(true);
        }
      });
      events.addEventListener("installed-notes", (event) => {
        if (disposed) return;
        const value = JSON.parse((event as MessageEvent).data) as ReleaseNotes | null;
        setInstalledNotes(value);
        setInstalledFailure(false);
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
              shutdownExpected = false;
              focusBeforeUpdate.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              flushSync(() => { setFrozen(true); setFailed(false); setExpanded(false); });
              await rendererUpdateParticipants.prepare(updateId);
              ok = activeUpdate === updateId && rendererUpdateParticipants.confirm(updateId);
            } else if (value.action === "confirm") {
              ok = activeUpdate === updateId && rendererUpdateParticipants.confirm(updateId);
              if (ok) {
                shutdownExpected = true;
                setFailed(false);
              }
            }
          } catch { ok = false; }
          if (disposed || epoch !== myEpoch) return;
          const ack = await fetch("/api/desktop/update/ack", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: value.requestId, connectionId, ok }),
          });
          if (!ack.ok && activeUpdate) setFailed(true);
        })().catch(() => { if (!disposed && activeUpdate && !shutdownExpected) setFailed(true); });
      });
      events.onerror = () => {
        epoch += 1;
        // Workbench intentionally closes this stream after shutdown confirmation.
        if (activeUpdate && !shutdownExpected) setFailed(true);
      };
    }).catch(() => { /* Update discovery must not prevent normal Web startup. */ });
    return () => {
      disposed = true;
      epoch += 1;
      choiceEpoch.current += 1;
      currentOfferId.current = null;
      currentAttemptId.current = null;
      activityRef.current = null;
      choosingOfferId.current = null;
      events?.close();
    };
  }, []);

  const dismissInstalledNotes = useCallback(async (): Promise<void> => {
    if (!installedNotes) return;
    try {
      const response = await fetch("/api/desktop/update/notes-ack", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: installedNotes.version }),
      });
      if (!response.ok) throw new Error("ack rejected");
      installedDialog.current?.close();
      setInstalledNotes((current) => current?.version === installedNotes.version ? null : current);
      setInstalledFailure(false);
    } catch { setInstalledFailure(true); }
  }, [installedNotes]);

  const install = useCallback(async (): Promise<void> => {
    if (!offer || activityRef.current?.phase !== "ready" || activityRef.current.attemptId !== offer.offerId
      || choosingOfferId.current) return;
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
      available: Boolean(activity),
      phase: activity?.phase ?? null,
      percent: activity?.phase === "downloading" ? activity.percent ?? null : null,
      version: activity?.version ?? null,
      releaseUrl: offer?.releaseUrl ?? null,
      notes: offer?.notes,
      expanded: Boolean(activity) && expanded && !frozen,
      submitting: choosing,
      failure: choiceFailure,
    },
    actions: {
      open: () => { if (activity) setExpanded(true); },
      dismiss: () => setExpanded(false),
      openReleaseNotes: () => {
        if (!offer?.releaseUrl) return;
        setExpanded(false);
        window.open(offer.releaseUrl, "_blank", "noopener,noreferrer");
      },
      install,
    },
  }), [activity, choiceFailure, choosing, expanded, frozen, install, offer]);

  return <>
    <DesktopUpdateOfferContext.Provider value={offerSurface}>
      <div inert={frozen} aria-busy={frozen || undefined}>{children}</div>
    </DesktopUpdateOfferContext.Provider>
    <span className="sr-only" role="status" aria-live="polite">{activity?.phase === "ready"
      ? `Beaver Code ${activity.version} 更新已准备好`
      : activity?.phase === "verifying" ? "正在校验安装包" : ""}</span>
    {frozen && <dialog ref={notice} className="desktop-update-notice" aria-labelledby="desktop-update-title" aria-modal="true"
      onCancel={(event) => event.preventDefault()}>
      <strong id="desktop-update-title" role={failed ? "alert" : "status"}>{failed ? "更新暂未完成"
        : activity?.phase === "stopping" || activity?.phase === "installing" ? "正在重启并安装…" : "正在保存工作状态…"}</strong>
      <p>{failed ? "请在帮助菜单中查看诊断，或重新启动工作台。" : "保存完成后将自动重启 Beaver Code。"}</p>
    </dialog>}
    {installedNotes && <dialog ref={installedDialog} className="desktop-installed-notes" aria-labelledby="desktop-installed-notes-title"
      onCancel={(event) => { event.preventDefault(); void dismissInstalledNotes(); }}>
      <h2 id="desktop-installed-notes-title">Beaver Code {installedNotes.version} 更新内容</h2>
      <DesktopReleaseNotes key={installedNotes.version} notes={installedNotes} />
      {installedFailure && <p role="alert">暂时无法确认已读，请重试。</p>}
      <button type="button" onClick={() => void dismissInstalledNotes()}>完成</button>
    </dialog>}
  </>;
}
