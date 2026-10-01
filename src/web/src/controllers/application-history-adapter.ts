import type { ProductMode } from "../types.js";
import { applicationLocationUrl, readApplicationLocation, sameApplicationLocation, type ApplicationLocation } from "./application-navigation-contract.js";

interface HistoryEntry { version: 1; session: string; index: number; location: ApplicationLocation }
interface HistoryLedger { session: string; end: number }
const LEDGER_KEY = "aho.navigation.history.v1";
const STATE_KEY = "ahoNavigation";

/** Browser History is authoritative; the ledger contains bounds, never a second stack. */
export class ApplicationHistoryAdapter {
  private entry: HistoryEntry;
  private ledger: HistoryLedger;
  private readonly pending = new Map<string, string>();

  constructor(private readonly host: Window, fallbackMode: ProductMode) {
    const candidate = this.readEntry(host.history.state);
    let ledger: HistoryLedger | null = null;
    try { ledger = JSON.parse(host.sessionStorage.getItem(LEDGER_KEY) ?? "null") as HistoryLedger | null; } catch { /* Optional persistence. */ }
    const restored = candidate && ledger && ledger.session === candidate.session && Number.isSafeInteger(ledger.end) && ledger.end >= candidate.index;
    this.ledger = restored ? ledger! : { session: `${Date.now()}-${Math.random()}`, end: 0 };
    this.entry = restored ? candidate : { version: 1, session: this.ledger.session, index: 0,
      location: readApplicationLocation(new URL(host.location.href), fallbackMode) };
    if (this.entry.location.conversationId?.startsWith("pending:")) this.entry.location = { ...this.entry.location, conversationId: null, resource: null };
    this.write("replace", this.entry.location);
  }

  get snapshot(): { location: ApplicationLocation; canGoBack: boolean; canGoForward: boolean } {
    return { location: this.entry.location, canGoBack: this.entry.index > 0, canGoForward: this.entry.index < this.ledger.end };
  }

  visit(location: ApplicationLocation): boolean {
    if (sameApplicationLocation(location, this.entry.location)) return false;
    this.entry = { ...this.entry, index: this.entry.index + 1 };
    this.ledger.end = this.entry.index;
    this.write("push", location);
    return true;
  }

  replace(location: ApplicationLocation): void { this.write("replace", location); }
  back(): void { if (this.snapshot.canGoBack) this.host.history.back(); }
  forward(): void { if (this.snapshot.canGoForward) this.host.history.forward(); }

  rekey(projectId: string, productMode: ProductMode, pendingId: string, conversationId: string): void {
    this.pending.set(`${projectId}\0${productMode}\0${pendingId}`, conversationId);
    const current = this.entry.location;
    if (current.projectId === projectId && current.productMode === productMode && current.conversationId === pendingId) {
      this.replace({ ...current, conversationId });
    }
  }

  subscribe(listener: () => void, canNavigate: () => boolean = () => true): () => void {
    const onPopState = (): void => {
      const candidate = this.readEntry(this.host.history.state);
      if (candidate?.session === this.ledger.session && !canNavigate()) {
        const distance = this.entry.index - candidate.index;
        if (distance) this.host.history.go(distance);
        return;
      }
      if (candidate?.session === this.ledger.session) this.entry = candidate;
      else {
        this.ledger = { session: `${Date.now()}-${Math.random()}`, end: 0 };
        this.entry = { version: 1, session: this.ledger.session, index: 0,
          location: readApplicationLocation(new URL(this.host.location.href), this.entry.location.productMode) };
      }
      const current = this.entry.location;
      const canonical = current.conversationId?.startsWith("pending:")
        ? this.pending.get(`${current.projectId}\0${current.productMode}\0${current.conversationId}`) : undefined;
      if (canonical) this.write("replace", { ...current, conversationId: canonical });
      listener();
    };
    this.host.addEventListener("popstate", onPopState);
    return () => this.host.removeEventListener("popstate", onPopState);
  }

  private write(kind: "push" | "replace", location: ApplicationLocation): void {
    this.entry = { ...this.entry, location };
    const state = { ...(this.host.history.state ?? {}), [STATE_KEY]: this.entry };
    const url = applicationLocationUrl(location, new URL(this.host.location.href));
    if (kind === "push") this.host.history.pushState(state, "", url);
    else this.host.history.replaceState(state, "", url);
    try { this.host.sessionStorage.setItem(LEDGER_KEY, JSON.stringify(this.ledger)); } catch { /* Navigation remains usable. */ }
  }

  private readEntry(state: unknown): HistoryEntry | null {
    try {
    if (!state || typeof state !== "object") return null;
    const entry = (state as Record<string, unknown>)[STATE_KEY] as HistoryEntry | undefined;
    if (!entry || entry.version !== 1 || typeof entry.session !== "string" || !Number.isSafeInteger(entry.index)
      || entry.index < 0 || !entry.location || !["agent", "harness"].includes(entry.location.productMode)) return null;
    // Reuse the URL codec to validate routes supplied through History State.
    if (typeof entry.location.projectId !== "string" && entry.location.projectId !== null
      || typeof entry.location.conversationId !== "string" && entry.location.conversationId !== null
      || !["workspace", "settings", "orchestration"].includes(entry.location.surface)) return null;
    const parsed = readApplicationLocation(new URL(applicationLocationUrl(entry.location, new URL(this.host.location.href)), this.host.location.href), entry.location.productMode);
    return { ...entry, location: { ...parsed, conversationId: entry.location.conversationId?.startsWith("pending:") && entry.location.conversationId.length <= 512
      ? entry.location.conversationId : parsed.conversationId } };
    } catch { return null; }
  }
}
