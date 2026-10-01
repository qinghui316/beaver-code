import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeWorkbenchLiveStream } from "../../src/web/src/api.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Workbench first confirmation watchdog", () => {
  it.each(["abort", "http", "missing-body", "parse", "read"])("clears the watchdog on %s failure", async (kind) => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    if (kind === "abort") vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    else if (kind === "http") vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    else if (kind === "missing-body") vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: null }));
    else {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        if (kind === "read") controller.error(new Error("read failed"));
        else { controller.enqueue(new TextEncoder().encode("event: bad\ndata: {invalid}\n\n")); controller.close(); }
      } });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    }
    await expect(consumeWorkbenchLiveStream("/live", {}, vi.fn(), { firstConfirmationTimeoutMs: 30_000, onFirstConfirmationTimeout: timeout })).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(timeout).not.toHaveBeenCalled();
  });

  it("ignores unrelated frames, reports timeout once and accepts a late exact confirmation", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    const timeout = vi.fn(), confirmed = vi.fn(), onEvent = vi.fn();
    const send = (id: string) => controller.enqueue(new TextEncoder().encode(`event: confirmed\ndata: {"id":"${id}"}\n\n`));
    const pending = consumeWorkbenchLiveStream<{ data: { id: string } }>("/live", {}, onEvent, {
      firstConfirmationTimeoutMs: 30_000, onFirstConfirmationTimeout: timeout, onFirstConfirmation: confirmed,
      isFirstConfirmation: (event) => event.data.id === "exact",
    });
    controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")); send("other");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(timeout).toHaveBeenCalledTimes(1); expect(confirmed).not.toHaveBeenCalled();
    send("exact"); await vi.advanceTimersByTimeAsync(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(timeout).toHaveBeenCalledTimes(1);
    controller.close(); await vi.advanceTimersByTimeAsync(1); await pending;
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("clears immediately after confirmation even while the provider keeps streaming", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }))));
    const timeout = vi.fn(), confirmed = vi.fn();
    const pending = consumeWorkbenchLiveStream("/live", {}, vi.fn(), { firstConfirmationTimeoutMs: 30_000, onFirstConfirmationTimeout: timeout, onFirstConfirmation: confirmed });
    controller.enqueue(new TextEncoder().encode('event: accepted\ndata: {}\n\n'));
    await vi.advanceTimersByTimeAsync(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(timeout).not.toHaveBeenCalled();
    controller.close(); await pending;
  });
  it("clears the watchdog when the initial fetch rejects", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const timeout = vi.fn();
    await expect(consumeWorkbenchLiveStream("/live", {}, vi.fn(), {
      firstConfirmationTimeoutMs: 30_000, onFirstConfirmationTimeout: timeout,
    })).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(timeout).not.toHaveBeenCalled();
  });
});
