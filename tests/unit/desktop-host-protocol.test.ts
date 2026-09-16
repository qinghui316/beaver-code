import { describe, expect, it } from "vitest";
import {
  DESKTOP_PROTOCOL_VERSION,
  isDesktopHostMessage,
  safeDiagnostic,
} from "../../src/desktop/protocol.js";

describe("desktop host protocol", () => {
  it("accepts exact versioned messages and rejects remote origins", () => {
    expect(isDesktopHostMessage({
      type: "bootstrap",
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      sessionToken: "secret",
      generation: "generation-1",
    })).toBe(true);
    expect(isDesktopHostMessage({
      type: "ready",
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      origin: "http://127.0.0.1:4317",
      generation: "generation-1",
    })).toBe(true);
    expect(isDesktopHostMessage({
      type: "ready",
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      origin: "https://example.com",
      generation: "generation-1",
    })).toBe(false);
    expect(isDesktopHostMessage({
      type: "bootstrap",
      protocolVersion: 1,
      sessionToken: "secret",
      generation: "generation-1",
    })).toBe(false);
  });

  it("validates request identity and bounded snapshots", () => {
    expect(isDesktopHostMessage({
      type: "quit-snapshot",
      requestId: "request-1",
      generation: "generation-1",
      state: "idle",
      activeTurnCount: 0,
      activeTerminalCount: 0,
      pendingInteractionCount: 0,
    })).toBe(true);
    expect(isDesktopHostMessage({
      type: "quit-snapshot",
      requestId: "request-1",
      generation: "generation-1",
      state: "idle",
      activeTurnCount: -1,
      activeTerminalCount: 0,
      pendingInteractionCount: 0,
    })).toBe(false);
  });

  it("accepts only fixed desktop menus and bounded integer anchors", () => {
    const request = {
      type: "open-menu-request",
      requestId: "menu-1",
      generation: "generation-1",
      menuId: "file",
      anchor: { x: 18, y: 46 },
    };
    expect(isDesktopHostMessage(request)).toBe(true);
    expect(isDesktopHostMessage({ ...request, menuId: "system" })).toBe(false);
    expect(isDesktopHostMessage({ ...request, anchor: { x: -1, y: 46 } })).toBe(false);
    expect(isDesktopHostMessage({ ...request, anchor: { x: 18.5, y: 46 } })).toBe(false);
    expect(isDesktopHostMessage({
      type: "open-menu-result",
      requestId: "menu-1",
      generation: "generation-1",
      menuId: "file",
      opened: true,
    })).toBe(true);
  });

  it("binds update messages to bounded identity and exact generation", () => {
    const identity = {
      updateId: "update-1", generation: "generation-1", targetVersion: "0.1.3",
      artifactSha512: Buffer.alloc(64, 1).toString("base64"),
    };
    const request = { type: "update-request", requestId: "request-1", generation: "generation-1", identity, action: "prepare" };
    expect(isDesktopHostMessage(request)).toBe(true);
    expect(isDesktopHostMessage({ ...request, generation: "old" })).toBe(false);
    expect(isDesktopHostMessage({ ...request, requestId: "x".repeat(129) })).toBe(false);
    expect(isDesktopHostMessage({ ...request, action: "install" })).toBe(false);
    expect(isDesktopHostMessage({ type: "update-result", requestId: "request-1", generation: "generation-1", identity, result: "stopped" })).toBe(true);
    expect(isDesktopHostMessage({ type: "update-result", requestId: "request-1", generation: "generation-1", identity, result: "failed", diagnostic: safeDiagnostic("shutdown", "closing local connections") })).toBe(true);
    expect(isDesktopHostMessage({ type: "update-result", requestId: "request-1", generation: "generation-1", identity, result: "failed", diagnostic: { stage: "shutdown", summary: "x".repeat(401) } })).toBe(false);
    expect(isDesktopHostMessage({ type: "update-result", requestId: "request-1", generation: "generation-1", identity, result: "success" })).toBe(false);
  });

  it("accepts only the fixed Beaver Code release URL and bounded update choices", () => {
    const offer = { offerId: "offer-1", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3" };
    expect(isDesktopHostMessage({ type: "update-offer", generation: "generation-1", offer })).toBe(true);
    expect(isDesktopHostMessage({ type: "update-offer", generation: "generation-1", offer: { ...offer, releaseUrl: "https://example.com/v0.1.3" } })).toBe(false);
    expect(isDesktopHostMessage({ type: "update-choice", generation: "generation-1", offerId: "offer-1", action: "install" })).toBe(true);
    expect(isDesktopHostMessage({ type: "update-choice", generation: "generation-1", offerId: "offer-1", action: "force" })).toBe(false);
  });

  it("redacts local paths and bounds diagnostics", () => {
    const diagnostic = safeDiagnostic("runtime", new Error(`Failed at C:\\Users\\Jane Doe\\秘密项目\\secret.ts\n${"x".repeat(800)}`));
    expect(diagnostic.summary).toContain("[本地路径]");
    expect(diagnostic.summary).not.toContain("Jane Doe");
    expect(diagnostic.summary).not.toContain("秘密项目");
    expect(diagnostic.summary.length).toBeLessThanOrEqual(400);

    const unc = safeDiagnostic("runtime", new Error("Failed at \\\\server\\Shared Folder\\客户甲\\token.txt"));
    expect(unc.summary).toBe("Failed at [本地路径]");

    const unix = safeDiagnostic("runtime", new Error("Failed at '/Users/Jane Doe/秘密项目/token.txt' (denied)"));
    expect(unix.summary).toBe("Failed at '[本地路径]' (denied)");
  });
});
