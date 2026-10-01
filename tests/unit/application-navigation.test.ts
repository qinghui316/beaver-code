import { describe, expect, it, vi } from "vitest";
import { ApplicationHistoryAdapter } from "../../src/web/src/controllers/application-history-adapter.js";
import { applicationLocationUrl, readApplicationLocation, type ApplicationLocation } from "../../src/web/src/controllers/application-navigation-contract.js";

const location: ApplicationLocation = { productMode: "agent", projectId: "repo", conversationId: "one", surface: "workspace", settingsSection: "provider", resource: null };

describe("Application History owner", () => {
  it("restores exact modes, settings and resources and clears only the forward branch", () => {
    const host = browser(); const history = new ApplicationHistoryAdapter(host, "agent");
    const changed = vi.fn(); history.subscribe(changed);
    history.visit(location);
    history.visit({ ...location, resource: { kind: "project-file", relativePath: "src/main.ts" } });
    history.visit({ ...location, productMode: "harness", conversationId: "two", surface: "settings", settingsSection: "skills" });
    history.back(); expect(history.snapshot.location.resource).toEqual({ kind: "project-file", relativePath: "src/main.ts" });
    history.back(); expect(history.snapshot.location).toEqual(location);
    history.forward(); expect(history.snapshot.canGoForward).toBe(true);
    history.visit({ ...location, surface: "orchestration" });
    expect(history.snapshot.canGoForward).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(history.visit({ ...location, surface: "orchestration" })).toBe(false);
  });

  it("maps a background creation without moving the current page or duplicating history", () => {
    const host = browser(); const history = new ApplicationHistoryAdapter(host, "agent"); history.subscribe(() => undefined);
    history.visit({ ...location, conversationId: "pending:request" });
    history.visit({ ...location, surface: "settings", settingsSection: "skills" });
    const before = host.history.length;
    history.rekey("repo", "agent", "pending:request", "created");
    expect(history.snapshot.location.surface).toBe("settings");
    expect(history.snapshot.location.conversationId).toBe("one");
    history.back(); expect(history.snapshot.location.conversationId).toBe("created");
    expect(host.history.length).toBe(before);
    expect(new URL(host.location.href).searchParams.get("topic")).toBe("created");
  });

  it("keeps history bounds after refresh and never restores an unconfirmed create", () => {
    const host = browser(); let history = new ApplicationHistoryAdapter(host, "agent"); let unsubscribe = history.subscribe(() => undefined);
    history.visit(location); history.visit({ ...location, surface: "settings" }); history.back(); unsubscribe();
    history = new ApplicationHistoryAdapter(host, "agent"); unsubscribe = history.subscribe(() => undefined);
    expect(history.snapshot.canGoForward).toBe(true);
    history.visit({ ...location, conversationId: "pending:request" }); unsubscribe();
    history = new ApplicationHistoryAdapter(host, "agent");
    expect(history.snapshot.location.projectId).toBe("repo");
    expect(history.snapshot.location.conversationId).toBeNull();
  });

  it("keeps a confirmation open by undoing managed popstate until navigation is allowed", () => {
    const host = browser(); const history = new ApplicationHistoryAdapter(host, "agent"); let allowed = false;
    const restore = vi.fn(); history.subscribe(restore, () => allowed); history.visit(location); history.visit({ ...location, surface: "settings" });
    history.back(); expect(history.snapshot.location.surface).toBe("settings"); expect(restore).not.toHaveBeenCalled();
    allowed = true; history.back(); expect(history.snapshot.location.surface).toBe("workspace"); expect(restore).toHaveBeenCalledTimes(1);
  });

  it("validates unknown state and deep links without granting arbitrary resource access", () => {
    const host = browser(); host.history.replaceState({ ahoNavigation: { version: 1, session: "x", index: 0,
      location: { ...location, conversationId: 123 } } }, "", "/?project=repo&topic=one&mode=agent");
    expect(() => new ApplicationHistoryAdapter(host, "harness")).not.toThrow();
    for (const relativePath of ["../private", "C:/private", "//host/private", "src/../../private"]) {
      const url = new URL(applicationLocationUrl({ ...location, resource: { kind: "project-file", relativePath } }, new URL(host.location.href)), host.location.href);
      expect(readApplicationLocation(url, "harness").resource).toBeNull();
    }
    const wrongAgent = new URL(applicationLocationUrl({ ...location, resource: { kind: "agent", conversationId: "other", agentSurfaceId: "child" } }, new URL(host.location.href)), host.location.href);
    expect(readApplicationLocation(wrongAgent, "agent").resource).toBeNull();
  });
});

function browser(): Window {
  const storage = new Map<string, string>(); const listeners = new Set<() => void>();
  const entries: Array<{ state: unknown; url: string }> = [{ state: {}, url: "http://localhost/" }]; let index = 0;
  const go = (distance: number): void => { const next = index + distance; if (next < 0 || next >= entries.length) return; index = next; for (const listener of listeners) listener(); };
  return { location: { get href() { return entries[index]!.url; } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    history: { get state() { return entries[index]!.state; }, get length() { return entries.length; },
      pushState(state: unknown, _title: string, url: string) { entries.splice(index + 1); entries.push({ state: structuredClone(state), url: new URL(url, entries[index]!.url).href }); index++; },
      replaceState(state: unknown, _title: string, url: string) { entries[index] = { state: structuredClone(state), url: new URL(url, entries[index]!.url).href }; },
      back: () => go(-1), forward: () => go(1), go },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener), removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  } as unknown as Window;
}
