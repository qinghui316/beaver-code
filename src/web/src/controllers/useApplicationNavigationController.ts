import { useEffect, useRef, useState } from "react";
import type { ProductMode } from "../types.js";
import { ApplicationHistoryAdapter } from "./application-history-adapter.js";
import type { ApplicationLocation } from "./application-navigation-contract.js";

export interface ApplicationNavigationPorts {
  captureLeaving(): void;
  restore(location: ApplicationLocation, isCurrent: () => boolean): Promise<void>;
  onError(cause: unknown): void;
}

export function useApplicationNavigationController(fallbackMode: ProductMode) {
  const [history] = useState(() => new ApplicationHistoryAdapter(window, fallbackMode));
  const [snapshot, setSnapshot] = useState(history.snapshot);
  const ports = useRef<ApplicationNavigationPorts | null>(null);
  const generation = useRef(0);
  const replaying = useRef(false);
  const ready = useRef(false);
  const canNavigate = (): boolean => !document.querySelector('[role="dialog"][aria-modal="true"]:not([aria-label="左侧项目栏"])');

  async function apply(location: ApplicationLocation): Promise<void> {
    const token = ++generation.current;
    ports.current?.captureLeaving();
    replaying.current = true;
    setSnapshot(history.snapshot);
    try { await ports.current?.restore(location, () => token === generation.current); }
    catch (cause) { if (token === generation.current) ports.current?.onError(cause); }
    finally { if (token === generation.current) { replaying.current = false; setSnapshot(history.snapshot); } }
  }

  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => history.subscribe(() => { void applyRef.current(history.snapshot.location); }, canNavigate), [history]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !canNavigate()) return;
      if (event.key === "ArrowLeft" && history.snapshot.canGoBack) { event.preventDefault(); history.back(); }
      if (event.key === "ArrowRight" && history.snapshot.canGoForward) { event.preventDefault(); history.forward(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [history]);

  return {
    ...snapshot, ports,
    getLocation: () => history.snapshot.location,
    back: () => { if (canNavigate()) history.back(); }, forward: () => { if (canNavigate()) history.forward(); },
    visit: async (patch: Partial<ApplicationLocation>): Promise<void> => {
      if (!canNavigate()) return;
      const location = { ...history.snapshot.location, ...patch };
      if (history.visit(location)) await apply(location);
    },
    initialize: async (): Promise<void> => { if (!ready.current) { ready.current = true; await apply(history.snapshot.location); } },
    syncSession: (projectId: string | null, conversationId: string | null, productMode: ProductMode): void => {
      if (replaying.current) return;
      const current = history.snapshot.location;
      if (!ready.current) return;
      if (conversationId?.startsWith("pending:") && current.conversationId !== conversationId) {
        history.visit({ ...current, projectId, conversationId, productMode, surface: "workspace", resource: null });
      } else {
        if (current.conversationId?.startsWith("pending:") && conversationId) history.rekey(projectId!, productMode, current.conversationId, conversationId);
        history.replace({ ...history.snapshot.location, projectId, conversationId, productMode });
      }
      setSnapshot(history.snapshot);
    },
    rekey: (projectId: string, productMode: ProductMode, pendingId: string, conversationId: string): void => {
      history.rekey(projectId, productMode, pendingId, conversationId); setSnapshot(history.snapshot);
    },
    replace: (patch: Partial<ApplicationLocation>): void => {
      history.replace({ ...history.snapshot.location, ...patch }); setSnapshot(history.snapshot);
    },
  };
}
