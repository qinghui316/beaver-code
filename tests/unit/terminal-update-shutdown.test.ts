import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRuntime } from "../../src/server/terminal/terminal-runtime.js";

afterEach(() => vi.useRealTimers());
async function fixture() {
  const exits = new Set<(event: { exitCode: number }) => void>();
  const pty = {
    kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    onData: () => ({ dispose() {} }),
    onExit: (callback: (event: { exitCode: number }) => void) => {
      exits.add(callback);
      return { dispose: () => { exits.delete(callback); } };
    },
  };
  const runtime = new TerminalRuntime({ loadPty: async () => ({ spawn: () => pty }) as unknown as typeof import("node-pty") });
  await runtime.open({ projectId: "fixture", cwd: tmpdir(), terminalId: "terminal" });
  return { runtime, pty, exit: () => { for (const callback of [...exits]) callback({ exitCode: 0 }); } };
}

describe("update Terminal exit evidence", () => {
  it("single-flights concurrent opens for the same scoped terminal", async () => {
    let releaseLoad!: () => void;
    const loadReady = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const spawn = vi.fn(() => ({
      kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
    }));
    const runtime = new TerminalRuntime({
      loadPty: async () => {
        await loadReady;
        return { spawn } as unknown as typeof import("node-pty");
      },
    });
    const request = { projectId: "fixture", cwd: tmpdir(), terminalId: "terminal" };
    const first = runtime.open(request);
    const second = runtime.open(request);
    releaseLoad();

    const [firstSession, secondSession] = await Promise.all([first, second]);
    expect(firstSession).toEqual(secondSession);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(runtime.activeSessionCount()).toBe(1);
    runtime.cleanup();
  });

  it("waits for a real PTY exit instead of declaring success after kill", async () => {
    const { runtime, pty, exit } = await fixture();
    let completed = false;
    const pending = runtime.shutdown().then(() => { completed = true; });
    expect(pty.kill).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(runtime.activeSessionCount()).toBe(1);
    exit();
    await pending;
    expect(runtime.activeSessionCount()).toBe(0);
  });
  it("keeps unknown live sessions visible after a deadline", async () => {
    const { runtime, exit } = await fixture();
    vi.useFakeTimers();
    const pending = runtime.shutdown(20);
    const rejected = expect(pending).rejects.toThrow("shutdown failed");
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(runtime.activeSessionCount()).toBe(1);
    exit();
  });
});
