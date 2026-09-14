import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OfficeAssetLoader } from "../../src/web/src/office/officeAssetLoader.js";
import { AmbientScheduler, type OfficeClock, type RandomSource } from "../../src/web/src/office/ambientScheduler.js";
import { ChoreographyEngine } from "../../src/web/src/office/choreographyEngine.js";
import { OfficeDirector } from "../../src/web/src/office/officeDirector.js";
import { leisureScreen, OfficeBehaviorPolicy, participantBehaviorActor } from "../../src/web/src/office/officeBehaviorPolicy.js";
import { OfficeActivityCompiler } from "../../src/web/src/office/officeActivityCompiler.js";
import { OfficeCalibrationResolver } from "../../src/web/src/office/officeCalibrationResolver.js";
import { parseOfficeCalibrationJson } from "../../src/web/src/office/officeCalibrationDocument.js";
import { commitLatestOfficeRender } from "../../src/web/src/office/officeRenderGeneration.js";
import type { OfficeAmbientIntent, OfficeExperienceSnapshot, OfficeParticipant, OfficePresentationPreferences } from "../../src/web/src/office/officeExperience.js";
import { applyScarfMask } from "../../src/web/src/office/officeRuntimeAssets.js";
import { removeOfficeTickerIfCurrent } from "../../src/web/src/office/officeRendererLifecycle.js";
import { officeRouteFrameAt } from "../../src/web/src/office/officeRouteInterpolation.js";
import type { OfficeRuntimeVisualCommand } from "../../src/web/src/office/officeVisualContract.js";

const resolver = new OfficeCalibrationResolver(parseOfficeCalibrationJson(readFileSync("src/web/public/agent-office/config/office-calibration.json", "utf8")));
const LOOK_TEST_TIMING = {
  ordinaryDelayMs: { min: 8_000, max: 8_000 },
  mobilityDelayMs: { min: 500_000, max: 500_000 },
  lookAroundDelayMs: { min: 90_000, max: 90_000 },
  lookAroundActorCooldownMs: 180_000,
};
const MOBILITY_TEST_TIMING = {
  ordinaryDelayMs: { min: 8_000, max: 8_000 },
  mobilityDelayMs: { min: 25_000, max: 25_000 },
  lookAroundDelayMs: { min: 500_000, max: 500_000 },
  lookAroundActorCooldownMs: 180_000,
};

function createOfficeDirector(
  engine: ChoreographyEngine,
  clock: OfficeClock = fakeTimerClock(),
  random: RandomSource = { next: () => 0 },
): OfficeDirector {
  return new OfficeDirector(
    engine,
    resolver,
    new OfficeBehaviorPolicy(),
    new OfficeActivityCompiler(resolver),
    clock,
    random,
  );
}

function dormantClock(): OfficeClock {
  return { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined };
}

function fakeTimerClock(): OfficeClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function leisureProfile(
  actorId: string,
  preferences: OfficeParticipant["presentationPreferences"]["screens"],
): "entertainment-1" | "entertainment-2" {
  return leisureScreen(actorId, preferences) === "game-1" ? "entertainment-1" : "entertainment-2";
}

describe("Office runtime owners", () => {
  afterEach(() => vi.useRealTimers());

  it("compiles handoff posture depth and every independent mirror from the V5 route", () => {
    const compiler = new OfficeActivityCompiler(resolver);
    const mainStation = resolver.stations().find((station) => station.stationId === "main")!;
    const route = mainStation.handoffRoutes.planning!;
    const commands = flattenCommands(compiler.dispatch("main", "child", "main", route));

    expect(commands.filter((command) => command.kind === "setActorDepth")).toEqual([
      { kind: "setActorDepth", actorId: "main", mode: "mobile" },
      { kind: "setActorDepth", actorId: "main", mode: "mobile" },
      { kind: "setActorDepth", actorId: "child", mode: "seated" },
      { kind: "setActorDepth", actorId: "child", mode: "seated" },
      { kind: "setActorDepth", actorId: "main", mode: "seated" },
    ]);
    expect(commands).toContainEqual(expect.objectContaining({
      kind: "playAction",
      actorId: "main",
      actionId: "off-chair",
      reverse: true,
      flipX: route.actionMirrors["finish:off-chair"],
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      kind: "playRouteStage",
      actorId: "main",
      routeId: "handoff:standing-talk",
      flipX: route.actionMirrors["interaction:standing-talk"],
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      kind: "playRouteStage",
      actorId: "child",
      routeId: "handoff:seated-talk",
      flipX: route.actionMirrors["interaction:seated-talk"],
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      kind: "playRouteStage",
      actorId: "child",
      routeId: "handoff:salute",
      flipX: route.actionMirrors["interaction:salute"],
    }));
  });

  it("keeps station behavior seated and brackets facility travel with mobile then seated depth", () => {
    const compiler = new OfficeActivityCompiler(resolver);
    const station = resolver.stations().find((candidate) => candidate.stationId === "main")!;
    const main = participant("main", "main", "main", "idle");
    const behavior = flattenCommands(compiler.behaviorAtStation(
      participantBehaviorActor(main),
      { kind: "seated", seated: { screen: "work", effect: "none" } },
      station,
    ));
    expect(behavior).toContainEqual({ kind: "setActorDepth", actorId: "main", mode: "seated" });

    const facility = flattenCommands(compiler.ambient("main", station, { kind: "facility", facilityId: "coffee" }));
    expect(facility[0]).toEqual({ kind: "setActorDepth", actorId: "main", mode: "mobile" });
    expect(facility.at(-1)).toEqual({ kind: "setActorDepth", actorId: "main", mode: "seated" });
  });

  it("deduplicates concurrent asset loads", async () => {
    const importer = vi.fn(async (key: string) => ({ key }));
    const loader = new OfficeAssetLoader(importer);
    const [first, second] = await Promise.all([loader.acquire("idle", "actor-a"), loader.acquire("idle", "actor-b")]);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(first.asset).toBe(second.asset);
    first.release();
    second.release();
  });

  it("reference-counts repeated acquisitions from the same actor owner", async () => {
    const dispose = vi.fn();
    const loader = new OfficeAssetLoader(async (key: string) => ({ key }), 0, dispose);
    const first = await loader.acquire("shared", "actor-a", "ambient");
    const second = await loader.acquire("shared", "actor-a", "ambient");
    first.release();
    expect(loader.stats().referenced).toBe(1);
    expect(dispose).not.toHaveBeenCalled();
    second.release();
    expect(loader.stats().referenced).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes an asset that resolves after its load generation is cancelled", async () => {
    let resolveImport: ((asset: { key: string }) => void) | undefined;
    const dispose = vi.fn();
    const loader = new OfficeAssetLoader<{ key: string }>(
      () => new Promise((resolve) => { resolveImport = resolve; }),
      12,
      dispose,
    );
    const acquire = loader.acquire("late-atlas", "actor-a");

    loader.dispose();
    const lateAsset = { key: "late-atlas" };
    resolveImport?.(lateAsset);

    await expect(acquire).rejects.toMatchObject({ name: "AbortError" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(lateAsset);
    loader.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("semantic animation cancels the actor ambient channel and scope reset aborts work", async () => {
    const runtime = new ChoreographyEngine();
    const signals: AbortSignal[] = [];
    runtime.subscribe((_command, signal) => { signals.push(signal); });
    const ambient = runtime.run("agent-a", { kind: "playAction", actorId: "agent-a", actionId: "peek", durationMs: 10_000 }, "ambient");
    await Promise.resolve();
    const semantic = runtime.run("agent-a", { kind: "playAction", actorId: "agent-a", actionId: "working", durationMs: 10_000 }, "semantic");
    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    runtime.resetScope();
    expect(signals[1]?.aborted).toBe(true);
    await Promise.all([ambient, semantic]);
  });

  it("lets each newer canonical semantic transition replace the prior pose", async () => {
    const runtime = new ChoreographyEngine();
    const actions: string[] = [];
    runtime.subscribe((command) => { if (command.kind === "playAction") actions.push(command.actionId); });
    for (const actionId of ["working", "salute", "working", "salute", "working"] as const) {
      await runtime.run("agent-a", { kind: "playAction", actorId: "agent-a", actionId }, "semantic");
    }
    expect(actions).toEqual(["working", "salute", "working", "salute", "working"]);
  });

  it("destroys unreferenced ambient atlases when the LRU budget is exceeded", async () => {
    const dispose = vi.fn();
    const loader = new OfficeAssetLoader(async (key: string) => ({ key }), 1, dispose);
    const first = await loader.acquire("ambient-a", "actor", "ambient");
    first.release();
    const second = await loader.acquire("ambient-b", "actor", "ambient");
    second.release();
    expect(dispose).toHaveBeenCalledWith({ key: "ambient-a" });
    expect(loader.stats().resolved).toBe(1);
  });

  it("schedules life actions only for idle or completed actors and disables them for reduced motion", async () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const scheduler = new AmbientScheduler(async ({ actorId, intent }) => { actions.push(`${actorId}:${ambientIntentId(intent)}`); }, fakeTimerClock(), { next: () => 0 });
    scheduler.sync(snapshotWithStates(["idle", "working", "completed"]), true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(actions).toEqual(["actor-0:peek"]);
    const count = actions.length;
    scheduler.sync(snapshotWithStates(["idle", "idle", "idle"]), false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(actions).toHaveLength(count);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("does not restart an in-flight ambient timer after the scheduler is disabled", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const actions: string[] = [];
    const scheduler = new AmbientScheduler(async ({ actorId, intent }) => {
      actions.push(`${actorId}:${ambientIntentId(intent)}`);
      await new Promise<void>((resolve) => { finish = resolve; });
    }, fakeTimerClock(), { next: () => 0 });
    scheduler.sync(snapshotWithStates(["idle", "idle"]), true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(actions).toHaveLength(1);
    scheduler.sync(snapshotWithStates(["idle", "idle"]), false);
    finish?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actions).toHaveLength(1);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("ignores a cleared timer callback that was already queued before disable and re-enable", async () => {
    let now = 0;
    const callbacks: Array<() => void> = [];
    const run = vi.fn(async () => undefined);
    const scheduler = new AmbientScheduler(run, {
      now: () => now,
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length - 1;
      },
      clearTimeout: () => undefined,
    }, { next: () => 0 }, MOBILITY_TEST_TIMING);
    const snapshot = snapshotWithoutDesk(["idle"]);

    scheduler.sync(snapshot, true);
    scheduler.sync(snapshot, false);
    scheduler.sync(snapshot, true);
    now = 25_000;
    callbacks[0]!();
    await Promise.resolve();

    expect(run).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("runs at most two ambient stories while they occupy both slots", async () => {
    vi.useFakeTimers();
    const running: string[] = [];
    const finish: Array<() => void> = [];
    const scheduler = new AmbientScheduler(async ({ actorId, intent }) => {
      running.push(`${actorId}:${ambientIntentId(intent)}`);
      await new Promise<void>((resolve) => finish.push(resolve));
    }, fakeTimerClock(), { next: () => 0 });
    const snapshot = snapshotWithStates(["idle", "idle", "idle"]);
    snapshot.participants[0]!.presentationPreferences = preferences({ facilities: [{ id: "coffee", weight: 1 }] });
    snapshot.participants[1]!.presentationPreferences = preferences({ facilities: [{ id: "treadmill", weight: 1 }] });
    snapshot.participants[2]!.presentationPreferences = preferences({ desk: [{ id: "peek", weight: 1 }] });
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(running).toHaveLength(2);
    expect(running.filter((entry) => /coffee|treadmill|toilet/.test(entry))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(running).toHaveLength(2);
    finish.forEach((resolve) => resolve());
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("starts two overdue actors on different facilities and immediately drains the third after release", async () => {
    vi.useFakeTimers();
    const running: string[] = [];
    const finish: Array<() => void> = [];
    const scheduler = new AmbientScheduler(async ({ actorId, intent }) => {
      running.push(`${actorId}:${ambientIntentId(intent)}`);
      await new Promise<void>((resolve) => finish.push(resolve));
    }, fakeTimerClock(), { next: () => 0 }, MOBILITY_TEST_TIMING);
    const snapshot = snapshotWithoutDesk(["idle", "idle", "idle"]);
    snapshot.participants[0]!.presentationPreferences.facilities = [{ id: "coffee", weight: 1 }];
    snapshot.participants[1]!.presentationPreferences.facilities = [{ id: "treadmill", weight: 1 }];
    snapshot.participants[2]!.presentationPreferences.facilities = [{ id: "toilet", weight: 1 }];

    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(running).toEqual(["actor-0:coffee", "actor-1:treadmill"]);

    finish[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(running).toEqual(["actor-0:coffee", "actor-1:treadmill", "actor-2:toilet"]);

    finish.forEach((resolve) => resolve());
    scheduler.dispose();
  });

  it("keeps the same facility exclusive without a zero-delay retry loop", async () => {
    vi.useFakeTimers();
    const running: string[] = [];
    let release: (() => void) | undefined;
    const scheduler = new AmbientScheduler(async ({ actorId, intent }) => {
      running.push(`${actorId}:${ambientIntentId(intent)}`);
      await new Promise<void>((resolve) => { release = resolve; });
    }, fakeTimerClock(), { next: () => 0 }, MOBILITY_TEST_TIMING);
    const snapshot = snapshotWithoutDesk(["idle", "idle"]);
    for (const actor of snapshot.participants) actor.presentationPreferences.facilities = [{ id: "treadmill", weight: 1 }];

    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(running).toEqual(["actor-0:treadmill"]);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(running).toEqual(["actor-0:treadmill", "actor-1:treadmill"]);
    scheduler.dispose();
  });

  it("does not occupy an overdue actor with desk ambience while its facility is busy", async () => {
    vi.useFakeTimers();
    const running: string[] = [];
    const finish: Array<() => void> = [];
    const scheduler = new AmbientScheduler(async ({ actorId, intent }) => {
      running.push(`${actorId}:${ambientIntentId(intent)}`);
      if (intent.kind === "facility") await new Promise<void>((resolve) => finish.push(resolve));
    }, fakeTimerClock(), { next: () => 0 }, {
      ...MOBILITY_TEST_TIMING,
      ordinaryDelayMs: { min: 30_000, max: 30_000 },
    });
    const snapshot = snapshotWithoutDesk(["idle", "idle"]);
    snapshot.participants[0]!.presentationPreferences.facilities = [{ id: "treadmill", weight: 1 }];
    snapshot.participants[1]!.presentationPreferences.facilities = [{ id: "treadmill", weight: 1 }];
    snapshot.participants[1]!.presentationPreferences.desk = [{ id: "peek", weight: 1 }];

    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(running).toEqual(["actor-0:treadmill"]);

    finish[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(running).toEqual(["actor-0:treadmill", "actor-1:treadmill"]);
    scheduler.dispose();
  });

  it("pauses mobility deadlines while disabled and restarts eligibility with a fresh window", async () => {
    vi.useFakeTimers();
    const departures: number[] = [];
    const scheduler = new AmbientScheduler(async ({ intent }) => {
      if (intent.kind === "facility") departures.push(Date.now());
    }, fakeTimerClock(), { next: () => 0 }, MOBILITY_TEST_TIMING);
    const snapshot = snapshotWithoutDesk(["idle"]);
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(20_000);
    scheduler.sync(snapshot, false);
    await vi.advanceTimersByTimeAsync(100_000);
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(departures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(departures).toHaveLength(1);

    const ineligible = snapshotWithStates(["working"]);
    scheduler.sync(ineligible, true);
    await vi.advanceTimersByTimeAsync(100_000);
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(departures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(departures).toHaveLength(2);
    scheduler.dispose();
  });

  it("does not let a previous context callback release a same-id reservation in the new context", async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const finish: Array<() => void> = [];
    const scheduler = new AmbientScheduler(async ({ actorId }) => {
      starts.push(actorId);
      await new Promise<void>((resolve) => finish.push(resolve));
    }, fakeTimerClock(), { next: () => 0 }, MOBILITY_TEST_TIMING);
    const first = snapshotWithoutDesk(["idle"]);
    scheduler.sync(first, true);
    await vi.advanceTimersByTimeAsync(25_000);
    scheduler.sync({ ...first, contextId: "scope-2", revision: "scope-2" }, true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(starts).toEqual(["actor-0", "actor-0"]);

    finish[0]!();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(starts).toHaveLength(2);

    finish[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(3);
    scheduler.dispose();
  });

  it("does not let a removed actor callback release a re-added same-id reservation", async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const finish: Array<() => void> = [];
    const scheduler = new AmbientScheduler(async ({ actorIdentityKey }) => {
      starts.push(actorIdentityKey);
      await new Promise<void>((resolve) => finish.push(resolve));
    }, fakeTimerClock(), { next: () => 0 }, MOBILITY_TEST_TIMING);
    const first = snapshotWithoutDesk(["idle"]);
    scheduler.sync(first, true);
    await vi.advanceTimersByTimeAsync(25_000);

    scheduler.sync({ ...first, participants: [], revision: "removed" }, true);
    const replacement = snapshotWithoutDesk(["idle"]);
    replacement.participants[0]!.createdAt = "2026-08-01T00:00:00Z";
    replacement.revision = "replacement";
    scheduler.sync(replacement, true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(starts).toHaveLength(2);
    expect(starts[0]).not.toBe(starts[1]);

    finish[0]!();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(starts).toHaveLength(2);
    finish[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(3);
    scheduler.dispose();
  });

  it("orders equal mobility deadlines by opaque actor id regardless of projection order", async () => {
    vi.useFakeTimers();
    const ids = ["agent:codex:thread:z", "agent:claude:session:a", "ordinary-agent-7"];
    const runOrder = async (orderedIds: string[]): Promise<string[]> => {
      const starts: string[] = [];
      const scheduler = new AmbientScheduler(async ({ actorId }) => {
        starts.push(actorId);
        await new Promise<void>(() => undefined);
      }, fakeTimerClock(), { next: () => 0 }, MOBILITY_TEST_TIMING);
      const snapshot = snapshotWithoutDesk(["idle", "idle", "idle"]);
      snapshot.participants = orderedIds.map((actorId, index) => ({
        ...snapshot.participants[index]!,
        participantId: actorId,
        navigationId: actorId,
        createdAt: "2026-08-01T00:00:00Z",
        presentationPreferences: preferences({ facilities: [{ id: index === 0 ? "coffee" : index === 1 ? "treadmill" : "toilet", weight: 1 }] }),
      }));
      scheduler.sync(snapshot, true);
      await vi.advanceTimersByTimeAsync(25_000);
      scheduler.dispose();
      return starts;
    };

    const forward = await runOrder(ids);
    vi.setSystemTime(Date.now() + 1_000_000);
    const reverse = await runOrder([...ids].reverse());
    expect(forward).toEqual([...ids].sort().slice(0, 2));
    expect(reverse).toEqual(forward);
  });

  it("uses ordinary backoff after a rejected mobility attempt", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const scheduler = new AmbientScheduler(async ({ intent }) => {
      if (intent.kind === "facility") attempts.push(Date.now());
      return attempts.length > 1;
    }, fakeTimerClock(), { next: () => 0 }, MOBILITY_TEST_TIMING);
    scheduler.sync(snapshotWithoutDesk(["idle"]), true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(2);
    scheduler.dispose();
  });

  it("uses the same bounded cadence when Main is the only ambient candidate", async () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const scheduler = new AmbientScheduler(async ({ actorId, intent }) => { actions.push(`${actorId}:${ambientIntentId(intent)}`); }, fakeTimerClock(), { next: () => 0 });
    scheduler.sync(snapshotWithStates(["idle"]), true);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(actions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(actions).toEqual(["actor-0:peek"]);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("continues scheduling after an optional ambient action rejects", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) throw new Error("optional ambient asset failed");
    });
    const scheduler = new AmbientScheduler(run, fakeTimerClock(), { next: () => 0 });
    scheduler.sync(snapshotWithStates(["idle"]), true);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("keeps only residents eligible for ambient actions in a terminal current Office", async () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const scheduler = new AmbientScheduler(async ({ actorId, actorKind }) => { actions.push(`${actorKind}:${actorId}`); }, fakeTimerClock(), { next: () => 0 });
    const snapshot = snapshotWithStates(["completed"]);
    snapshot.lifecycle = "terminal";
    snapshot.residents = [{
      residentId: "resident:harness-evolution-agent",
      roleId: "harness-evolution-agent",
      label: "Harness Evolution Agent",
      stationId: snapshot.stations[0]!.stationId,
      scarf: "evolution",
      presentationPreferences: preferences(),
    }];
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(actions).toEqual([
      "resident:resident:harness-evolution-agent",
      "resident:resident:harness-evolution-agent",
    ]);
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("does not schedule look-around before 90 seconds of visible animation time", async () => {
    vi.useFakeTimers();
    const activities: string[] = [];
    const scheduler = new AmbientScheduler(
      async ({ intent }) => { activities.push(ambientIntentId(intent)); },
      fakeTimerClock(),
      { next: () => 0 },
      LOOK_TEST_TIMING,
    );
    scheduler.sync(snapshotWithoutDesk(["idle"]), true);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(activities).not.toContain("look-around");
    await vi.advanceTimersByTimeAsync(1);
    expect(activities.filter((activity) => activity === "look-around")).toHaveLength(1);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("pauses the look-around deadline while animation is disabled", async () => {
    vi.useFakeTimers();
    const activities: string[] = [];
    const scheduler = new AmbientScheduler(
      async ({ intent }) => { activities.push(ambientIntentId(intent)); },
      fakeTimerClock(),
      { next: () => 0 },
      LOOK_TEST_TIMING,
    );
    const snapshot = snapshotWithoutDesk(["idle"]);
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(40_000);
    scheduler.sync(snapshot, false);
    await vi.advanceTimersByTimeAsync(120_000);
    scheduler.sync(snapshot, true);

    await vi.advanceTimersByTimeAsync(49_999);
    expect(activities).not.toContain("look-around");
    await vi.advanceTimersByTimeAsync(1);
    expect(activities.filter((activity) => activity === "look-around")).toHaveLength(1);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("keeps a look-around completion cooldown paused when completion arrives while disabled", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    let finish: (() => void) | undefined;
    const scheduler = new AmbientScheduler(
      async ({ intent }) => {
        if (intent.kind !== "look-around") return;
        starts.push(Date.now());
        await new Promise<void>((resolve) => { finish = resolve; });
      },
      fakeTimerClock(),
      { next: () => 0 },
      LOOK_TEST_TIMING,
    );
    const snapshot = snapshotWithoutDesk(["idle"]);
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(starts).toHaveLength(1);
    scheduler.sync(snapshot, false);
    finish?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500_000);
    scheduler.sync(snapshot, true);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(starts).toHaveLength(2);
    scheduler.dispose();
  });

  it("enforces the 180 second same-actor look-around cooldown", async () => {
    vi.useFakeTimers();
    const lookAroundAt: number[] = [];
    const scheduler = new AmbientScheduler(
      async ({ intent }) => {
        if (intent.kind === "look-around") lookAroundAt.push(Date.now());
      },
      fakeTimerClock(),
      { next: () => 0 },
      LOOK_TEST_TIMING,
    );
    scheduler.sync(snapshotWithoutDesk(["idle"]), true);

    await vi.advanceTimersByTimeAsync(275_999);
    expect(lookAroundAt).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(lookAroundAt).toHaveLength(2);
    expect(lookAroundAt[1]! - lookAroundAt[0]!).toBeGreaterThanOrEqual(180_000);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("enforces the global look-around cooldown across different actors", async () => {
    vi.useFakeTimers();
    const lookAround: Array<{ actorId: string; at: number }> = [];
    const scheduler = new AmbientScheduler(
      async ({ actorId, intent }) => {
        if (intent.kind === "look-around") lookAround.push({ actorId, at: Date.now() });
      },
      fakeTimerClock(),
      { next: () => 0 },
      LOOK_TEST_TIMING,
    );
    scheduler.sync(snapshotWithoutDesk(["idle", "idle"]), true);

    await vi.advanceTimersByTimeAsync(179_999);
    expect(lookAround).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lookAround).toHaveLength(2);
    expect(lookAround[1]!.at - lookAround[0]!.at).toBeGreaterThanOrEqual(90_000);
    expect(lookAround[1]!.actorId).not.toBe(lookAround[0]!.actorId);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("starts a fresh rarity window when the graph scope changes", async () => {
    vi.useFakeTimers();
    const lookAroundAt: number[] = [];
    const scheduler = new AmbientScheduler(
      async ({ intent }) => {
        if (intent.kind === "look-around") lookAroundAt.push(Date.now());
      },
      fakeTimerClock(),
      { next: () => 0 },
      LOOK_TEST_TIMING,
    );
    const first = snapshotWithoutDesk(["idle"]);
    scheduler.sync(first, true);
    await vi.advanceTimersByTimeAsync(80_000);
    scheduler.sync({ ...first, contextId: "scope-2", revision: "scope-2" }, true);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(lookAroundAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lookAroundAt).toHaveLength(1);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("gives overdue mobility priority when a long desk action ends", async () => {
    vi.useFakeTimers();
    const activities: string[] = [];
    let finishAmbient: (() => void) | undefined;
    const scheduler = new AmbientScheduler(
      async ({ intent }) => {
        activities.push(ambientIntentId(intent));
        if (intent.kind !== "look-around") await new Promise<void>((resolve) => { finishAmbient = resolve; });
      },
      fakeTimerClock(),
      { next: () => 0 },
    );
    scheduler.sync(snapshotWithStates(["idle"]), true);
    await vi.advanceTimersByTimeAsync(104_000);
    expect(activities).toEqual(["peek"]);

    finishAmbient?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(activities).toEqual(["peek", "coffee"]);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("retries a due look-around when the runtime rejects a busy actor", async () => {
    vi.useFakeTimers();
    const lookAroundAttempts: number[] = [];
    let busy = true;
    const scheduler = new AmbientScheduler(
      async ({ intent }) => {
        if (intent.kind !== "look-around") return true;
        lookAroundAttempts.push(Date.now());
        if (busy) {
          busy = false;
          return false;
        }
        return true;
      },
      fakeTimerClock(),
      { next: () => 0 },
    );
    scheduler.sync(snapshotWithStates(["idle"]), true);

    await vi.advanceTimersByTimeAsync(96_000);
    expect(lookAroundAttempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(lookAroundAttempts).toHaveLength(2);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("clamps a route frame before its start to the first point", () => {
    expect(officeRouteFrameAt([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ], -0.25, 1_000)).toEqual({
      position: { x: 10, y: 20 },
      progress: 0,
    });
  });

  it("does not remove a ticker from an Office application that was already retired", () => {
    const remove = vi.fn();
    const app = { ticker: { remove } };
    const ticker = () => undefined;

    expect(removeOfficeTickerIfCurrent(app, null, ticker, null)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(removeOfficeTickerIfCurrent(app, app, ticker, ticker)).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("serializes live Main-to-Child dispatches and cancels a dispatch when its Child disappears", async () => {
    vi.useFakeTimers();
    const noAmbientClock = dormantClock();
    const engine = new ChoreographyEngine();
    const actions: Array<{ participantId: string; actionId: string }> = [];
    const positionedRoutes: string[] = [];
    engine.subscribe((command) => {
      if (command.kind === "playAction" || command.kind === "playRouteStage") actions.push({ participantId: command.actorId, actionId: command.actionId });
      if (command.kind === "playRouteStage") positionedRoutes.push(command.routeId);
    });
    const director = createOfficeDirector(engine, noAmbientClock);
    const main = participant("main", "main", "main", "idle");
    const childOne = participant("child-1", "child", "planning", "queued");
    const childTwo = participant("child-2", "child", "coder", "queued");
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await Promise.resolve();
    actions.length = 0;
    director.sync(officeSnapshot("scope-1", [main, childOne, childTwo]), [
      { kind: "participant-added", participantId: childOne.participantId, parentParticipantId: main.participantId },
      { kind: "participant-added", participantId: childTwo.participantId, parentParticipantId: main.participantId },
    ], false);
    await Promise.resolve();
    await vi.runAllTimersAsync();
    expect(actions.filter((item) => item.actionId === "seated-talk").map((item) => item.participantId)).toEqual(["child-1", "child-2"]);
    expect(positionedRoutes).toEqual(expect.arrayContaining(["handoff:standing-talk", "handoff:seated-talk", "handoff:salute"]));

    actions.length = 0;
    const childThree = participant("child-3", "child", "auditor", "queued");
    let notifyDispatchStarted: (() => void) | undefined;
    const dispatchStarted = new Promise<void>((resolve) => { notifyDispatchStarted = resolve; });
    const unsubscribe = engine.subscribe((command) => {
      if ((command.kind === "playAction" || command.kind === "playRouteStage") && command.actorId === "main" && command.actionId === "off-chair") notifyDispatchStarted?.();
    });
    director.sync(officeSnapshot("scope-1", [main, childOne, childTwo, childThree]), [
      { kind: "participant-added", participantId: childThree.participantId, parentParticipantId: main.participantId },
    ], false);
    await dispatchStarted;
    expect(actions.some((item) => item.participantId === "main" && item.actionId === "off-chair")).toBe(true);
    director.sync(officeSnapshot("scope-1", [main, childOne, childTwo]), [
      { kind: "participant-removed", participantId: childThree.participantId },
    ], false);
    await vi.runAllTimersAsync();
    expect(actions.some((item) => item.participantId === "child-3" && item.actionId === "seated-talk")).toBe(false);
    unsubscribe();
    director.dispose();
    vi.useRealTimers();
  });

  it("lights a newly seated Child screen before Main begins its dispatch", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const events: string[] = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen") events.push(`screen:${command.stationId}:${command.profile}`);
      if (command.kind === "playAction") events.push(`action:${command.actorId}:${command.actionId}`);
    });
    const director = createOfficeDirector(engine, dormantClock());
    const main = participant("main", "main", "main", "idle");
    const child = participant("child-1", "child", "planning", "queued");
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await Promise.resolve();
    events.length = 0;

    director.sync(officeSnapshot("scope-1", [main, child]), [
      { kind: "participant-added", participantId: child.participantId, parentParticipantId: main.participantId },
    ], false);
    await vi.advanceTimersByTimeAsync(0);

    const screenIndex = events.indexOf(`screen:planning:${leisureProfile(child.participantId, child.presentationPreferences.screens)}`);
    const departureIndex = events.indexOf("action:main:off-chair");
    expect(screenIndex).toBeGreaterThanOrEqual(0);
    expect(departureIndex).toBeGreaterThan(screenIndex);
    director.dispose();
    vi.useRealTimers();
  });

  it("does not relight a queued Child station after that Child is removed", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const coderProfiles: string[] = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen" && command.stationId === "coder") coderProfiles.push(command.profile);
    });
    const director = createOfficeDirector(engine, dormantClock());
    const main = participant("main", "main", "main", "idle");
    const first = participant("child-1", "child", "planning", "queued");
    const queued = participant("child-2", "child", "coder", "queued");
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    director.sync(officeSnapshot("scope-1", [main, first, queued]), [
      { kind: "participant-added", participantId: first.participantId, parentParticipantId: main.participantId },
      { kind: "participant-added", participantId: queued.participantId, parentParticipantId: main.participantId },
    ], false);
    await vi.advanceTimersByTimeAsync(0);
    expect(coderProfiles).toContain(leisureProfile(queued.participantId, queued.presentationPreferences.screens));

    director.sync(officeSnapshot("scope-1", [main, first]), [
      { kind: "participant-removed", participantId: queued.participantId },
    ], false);
    await vi.advanceTimersByTimeAsync(0);
    expect(coderProfiles.at(-1)).toBe("off");
    await vi.runAllTimersAsync();
    expect(coderProfiles.at(-1)).toBe("off");

    director.dispose();
    vi.useRealTimers();
  });

  it("waits for Main ambient to return before dispatch and restores the latest canonical state", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const actions: Array<{ participantId: string; actionId: string }> = [];
    engine.subscribe((command) => {
      if (command.kind === "playAction" || command.kind === "playRouteStage") actions.push({ participantId: command.actorId, actionId: command.actionId });
    });
    const director = createOfficeDirector(engine);
    const main = participant("main", "main", "main", "idle");
    const child = participant("child-1", "child", "planning", "queued");
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(actions.at(-1)).toEqual({ participantId: "main", actionId: "peek" });

    director.sync(officeSnapshot("scope-1", [main, child]), [
      { kind: "participant-added", participantId: child.participantId, parentParticipantId: main.participantId },
    ], false);
    await Promise.resolve();
    expect(actions.some((item) => item.participantId === "main" && item.actionId === "off-chair")).toBe(false);

    const workingMain = { ...main, state: "working" as const };
    director.sync(officeSnapshot("scope-1", [workingMain, child]), [
      { kind: "state-changed", participantId: main.participantId, from: "idle", to: "working" },
    ], false);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(actions.some((item) => item.participantId === "main" && item.actionId === "off-chair")).toBe(true);
    expect(actions.filter((item) => item.participantId === "main").at(-1)?.actionId).toBe("working");
    director.dispose();
    vi.useRealTimers();
  });

  it("cancels stale choreography and applies the latest state at a changed station", async () => {
    const engine = new ChoreographyEngine();
    const commands: Array<{ kind: string; actorId?: string; stationId?: string; profile?: string; routeId?: string; points?: Array<{ x: number; y: number }>; actionId?: string }> = [];
    engine.subscribe((command) => { commands.push(command); });
    const director = createOfficeDirector(engine, dormantClock());
    const before = participant("child-1", "child", "planning", "idle");
    director.hydrate(officeSnapshot("scope-1", [participant("main", "main", "main", "idle"), before]), false);
    await Promise.resolve();
    commands.length = 0;

    const after = { ...before, stationId: "coder", state: "working" as const };
    director.sync(officeSnapshot("scope-1", [participant("main", "main", "main", "idle"), after]), [
      { kind: "station-changed", participantId: after.participantId, fromStationId: "planning", toStationId: "coder" },
      { kind: "state-changed", participantId: after.participantId, from: "idle", to: "working" },
    ], false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const coder = resolver.stations().find((station) => station.stationId === "coder")!;
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "setScreen", stationId: "planning", profile: "off" }),
      expect.objectContaining({ kind: "playRouteStage", actorId: "child-1", routeId: "canonical-seat", actionId: "working", points: [coder.anchors.seat] }),
      expect.objectContaining({ kind: "setScreen", stationId: "coder", profile: "orchestration" }),
    ]));
    expect(commands.filter((command) => command.kind === "followRoute" && command.actorId === "child-1")).toHaveLength(0);
    director.dispose();
  });

  it("turns an occupied screen off only after facility departure and restores it on return", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const profiles: string[] = [];
    engine.subscribe(async (command) => {
      if (command.kind === "setScreen" && command.stationId === "main") profiles.push(command.profile);
      if (command.kind === "playRouteStage") {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, command.durationMs));
      }
    });
    const director = createOfficeDirector(engine);
    const main = participant("main", "main", "main", "idle");
    main.presentationPreferences.facilities = [{ id: "coffee", weight: 1 }];
    main.presentationPreferences.desk = [];
    const standbyProfile = leisureProfile(main.participantId, main.presentationPreferences.screens);
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await Promise.resolve();
    expect(profiles.at(-1)).toBe(standbyProfile);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(profiles.at(-1)).toBe(standbyProfile);
    const route = resolver.stations().find((station) => station.stationId === "main")!.facilityRoutes.coffee;
    await vi.advanceTimersByTimeAsync(route[0]!.durationMs);
    expect(profiles.at(-1)).toBe("off");
    await vi.advanceTimersByTimeAsync(route.slice(1).reduce((total, stage) => total + stage.durationMs, 0));
    expect(profiles.at(-1)).toBe(standbyProfile);

    director.dispose();
    vi.useRealTimers();
  });

  it("keeps the occupied leisure screen stable during desk ambience", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const profiles: string[] = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen" && command.stationId === "main") profiles.push(command.profile);
    });
    const director = createOfficeDirector(engine);
    const main = participant("main", "main", "main", "idle");
    main.presentationPreferences.screens = [{ id: "game-1", weight: 1 }];
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(profiles.at(-1)).toBe("entertainment-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(profiles.at(-1)).toBe(leisureProfile(main.participantId, main.presentationPreferences.screens));

    director.dispose();
    vi.useRealTimers();
  });

  it("does not let stale ambient cleanup cancel a completed salute", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const actions: string[] = [];
    engine.subscribe(async (command) => {
      if ((command.kind === "playAction" || command.kind === "playRouteStage") && command.actorId === "main") {
        actions.push(command.actionId);
      }
      if (command.kind === "playRouteStage" && command.durationMs > 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, command.durationMs));
      }
    });
    const director = createOfficeDirector(engine);
    const main = participant("main", "main", "main", "idle");
    main.presentationPreferences.desk = [{ id: "peek", weight: 1 }];
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await vi.advanceTimersByTimeAsync(8_000);
    actions.length = 0;

    const completed = { ...main, state: "completed" as const };
    director.sync(officeSnapshot("scope-1", [completed]), [
      { kind: "state-changed", participantId: main.participantId, from: "idle", to: "completed" },
    ], false);
    await vi.advanceTimersByTimeAsync(0);

    expect(actions).toEqual(["salute"]);
    await vi.advanceTimersByTimeAsync(resolver.action("salute").durationMs - 1);
    expect(actions).toEqual(["salute"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(actions).toEqual(["salute", "working"]);

    director.dispose();
    vi.useRealTimers();
  });

  it("does not let a pending ambient wakeup cancel an active completed salute", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const actions: string[] = [];
    engine.subscribe(async (command) => {
      if ((command.kind === "playAction" || command.kind === "playRouteStage") && command.actorId === "main") {
        actions.push(command.actionId);
      }
      if (command.kind === "playRouteStage" && command.durationMs > 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, command.durationMs));
      }
    });
    const director = createOfficeDirector(engine);
    const main = participant("main", "main", "main", "idle");
    main.presentationPreferences.desk = [{ id: "peek", weight: 1 }];
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await vi.advanceTimersByTimeAsync(7_000);
    actions.length = 0;

    const completed = { ...main, state: "completed" as const };
    director.sync(officeSnapshot("scope-1", [completed]), [
      { kind: "state-changed", participantId: main.participantId, from: "idle", to: "completed" },
    ], false);
    await vi.advanceTimersByTimeAsync(0);
    expect(actions).toEqual(["salute"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(actions).toEqual(["salute"]);
    await vi.advanceTimersByTimeAsync(resolver.action("salute").durationMs - 1_000);
    expect(actions).toEqual(["salute", "working"]);

    director.dispose();
    vi.useRealTimers();
  });

  it("does not let a removed resident turn off a station occupied by its real replacement", async () => {
    const engine = new ChoreographyEngine();
    const screens: Array<{ stationId: string; profile: string }> = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen") screens.push({ stationId: command.stationId, profile: command.profile });
    });
    const director = createOfficeDirector(engine, dormantClock());
    const main = participant("main", "main", "main", "idle");
    const previous = officeSnapshot("scope-1", [main]);
    previous.residents = [{
      residentId: "resident:harness-evolution-agent",
      roleId: "harness-evolution-agent",
      label: "Harness Evolution Agent",
      stationId: "planning",
      scarf: "evolution",
      presentationPreferences: preferences(),
    }];
    director.hydrate(previous, false);
    await Promise.resolve();
    screens.length = 0;

    const replacement = participant("child-1", "child", "planning", "idle");
    director.sync(officeSnapshot("scope-1", [main, replacement]), [
      { kind: "resident-removed", residentId: previous.residents[0]!.residentId },
      { kind: "participant-added", participantId: replacement.participantId, parentParticipantId: null },
    ], false);
    await Promise.resolve();

    expect(screens).toContainEqual({ stationId: "planning", profile: leisureProfile(replacement.participantId, replacement.presentationPreferences.screens) });
    expect(screens).not.toContainEqual({ stationId: "planning", profile: "off" });
    director.dispose();
  });

  it("does not let a displaced resident turn off the old station after a real Agent takes it", async () => {
    const engine = new ChoreographyEngine();
    const screens: Array<{ stationId: string; profile: string }> = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen") screens.push({ stationId: command.stationId, profile: command.profile });
    });
    const director = createOfficeDirector(engine, dormantClock());
    const main = participant("main", "main", "main", "idle");
    const previous = officeSnapshot("scope-1", [main]);
    const resident = {
      residentId: "resident:harness-evolution-agent",
      roleId: "harness-evolution-agent",
      label: "Harness Evolution Agent",
      stationId: "planning",
      scarf: "evolution" as const,
      presentationPreferences: preferences(),
    };
    previous.residents = [resident];
    director.hydrate(previous, false);
    await Promise.resolve();
    screens.length = 0;

    const replacement = participant("child-1", "child", "planning", "idle");
    const next = officeSnapshot("scope-1", [main, replacement]);
    next.residents = [{ ...resident, stationId: "coder" }];
    director.sync(next, [
      { kind: "participant-added", participantId: replacement.participantId, parentParticipantId: null },
      { kind: "resident-station-changed", residentId: resident.residentId, fromStationId: "planning", toStationId: "coder" },
    ], false);
    await Promise.resolve();

    expect(screens).toContainEqual({ stationId: "planning", profile: leisureProfile(replacement.participantId, replacement.presentationPreferences.screens) });
    expect(screens).toContainEqual({ stationId: "coder", profile: leisureProfile(resident.residentId, resident.presentationPreferences.screens) });
    expect(screens).not.toContainEqual({ stationId: "planning", profile: "off" });
    director.dispose();
  });

  it("clears vacated screens and restores every occupied screen across a scope reset", async () => {
    const engine = new ChoreographyEngine();
    const screens: Array<{ stationId: string; profile: string }> = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen") screens.push({ stationId: command.stationId, profile: command.profile });
    });
    const director = createOfficeDirector(engine, dormantClock());
    const priorMain = participant("main", "main", "main", "idle");
    const priorChild = participant("child-old", "child", "planning", "idle");
    director.hydrate(officeSnapshot("scope-old", [priorMain, priorChild]), false);
    await Promise.resolve();
    screens.length = 0;

    const nextMain = participant("main", "main", "main", "completed");
    const nextChild = participant("child-new", "child", "coder", "idle");
    director.sync(officeSnapshot("scope-new", [nextMain, nextChild]), [
      { kind: "scope-reset", previousContextId: "scope-old" },
    ], false);
    await Promise.resolve();

    expect(screens).toContainEqual({ stationId: "planning", profile: "off" });
    expect(screens).toContainEqual({ stationId: "main", profile: leisureProfile(nextMain.participantId, nextMain.presentationPreferences.screens) });
    expect(screens).toContainEqual({ stationId: "coder", profile: leisureProfile(nextChild.participantId, nextChild.presentationPreferences.screens) });
    director.dispose();
  });

  it("restores an occupied screen when semantic state interrupts a facility departure", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const profiles: string[] = [];
    engine.subscribe(async (command) => {
      if (command.kind === "setScreen" && command.stationId === "main") profiles.push(command.profile);
      if (command.kind === "playRouteStage") await new Promise<void>((resolve) => globalThis.setTimeout(resolve, command.durationMs));
    });
    const director = createOfficeDirector(engine);
    const main = participant("main", "main", "main", "idle");
    main.presentationPreferences.facilities = [{ id: "coffee", weight: 1 }];
    main.presentationPreferences.desk = [];
    director.hydrate(officeSnapshot("scope-1", [main]), false);
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.advanceTimersByTimeAsync(resolver.stations().find((station) => station.stationId === "main")!.facilityRoutes.coffee[0]!.durationMs);
    expect(profiles.at(-1)).toBe("off");

    const working = { ...main, state: "working" as const };
    director.sync(officeSnapshot("scope-1", [working]), [
      { kind: "state-changed", participantId: main.participantId, from: "idle", to: "working" },
    ], false);
    await Promise.resolve();
    expect(profiles.at(-1)).toBe("orchestration");

    director.dispose();
    vi.useRealTimers();
  });

  it("keeps occupied screens requested when reduced motion changes", async () => {
    const engine = new ChoreographyEngine();
    const profiles: string[] = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen") profiles.push(command.profile);
    });
    const director = createOfficeDirector(engine, dormantClock());
    const snapshot = officeSnapshot("scope-1", [participant("main", "main", "main", "idle")]);
    director.hydrate(snapshot, false);
    await Promise.resolve();
    profiles.length = 0;

    director.sync(snapshot, [], true);
    await Promise.resolve();

    expect(profiles).toContain(leisureProfile(snapshot.participants[0]!.participantId, snapshot.participants[0]!.presentationPreferences.screens));
    expect(profiles).not.toContain("off");
    director.dispose();
  });

  it("does not count hidden time before hydrate toward look-around rarity", async () => {
    vi.useFakeTimers();
    const engine = new ChoreographyEngine();
    const actions: string[] = [];
    engine.subscribe((command) => {
      if (command.kind === "playAction") actions.push(command.actionId);
    });
    const director = createOfficeDirector(engine, fakeTimerClock());
    const snapshot = officeSnapshot("scope-1", [participant("main", "main", "main", "idle")]);
    director.visibilityChanged(true);
    director.hydrate(snapshot, false);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(actions).not.toContain("standby");
    director.visibilityChanged(false);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(actions).not.toContain("standby");
    await vi.advanceTimersByTimeAsync(90_001);
    expect(actions.filter((action) => action === "standby").length).toBeGreaterThanOrEqual(1);

    director.dispose();
    vi.useRealTimers();
  });

  it("hides real participants on an initial terminal hydrate while restoring residents", async () => {
    const engine = new ChoreographyEngine();
    const commands: Array<{ kind: string; actorId?: string; stationId?: string; profile?: string; actionId?: string }> = [];
    engine.subscribe((command) => { commands.push(command); });
    const director = createOfficeDirector(engine, dormantClock());
    const snapshot = officeSnapshot("scope-terminal", [participant("main", "main", "main", "completed")]);
    snapshot.lifecycle = "terminal";
    snapshot.residents = [resident("resident:memory", "planning")];

    director.hydrate(snapshot, false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands).toContainEqual(expect.objectContaining({ kind: "hideParticipant", actorId: "main" }));
    expect(commands).toContainEqual(expect.objectContaining({ kind: "setScreen", stationId: "main", profile: "off" }));
    expect(commands).toContainEqual(expect.objectContaining({ actorId: "resident:memory", actionId: "working" }));
    expect(commands).not.toContainEqual(expect.objectContaining({ actorId: "main", actionId: expect.any(String) }));
    director.dispose();
  });

  it("keeps real participants hidden when reduced motion changes in a terminal scope", async () => {
    const engine = new ChoreographyEngine();
    const commands: Array<{ kind: string; actorId?: string; actionId?: string }> = [];
    engine.subscribe((command) => { commands.push(command); });
    const director = createOfficeDirector(engine, dormantClock());
    const snapshot = officeSnapshot("scope-terminal", [participant("main", "main", "main", "completed")]);
    snapshot.lifecycle = "terminal";
    snapshot.residents = [resident("resident:memory", "planning")];
    director.hydrate(snapshot, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    commands.length = 0;

    director.sync(snapshot, [], true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands).toContainEqual(expect.objectContaining({ kind: "hideParticipant", actorId: "main" }));
    expect(commands).toContainEqual(expect.objectContaining({ actorId: "resident:memory", actionId: "working" }));
    expect(commands).not.toContainEqual(expect.objectContaining({ actorId: "main", actionId: expect.any(String) }));
    director.dispose();
  });

  it("does not restore real participants during a terminal scope reset", async () => {
    const engine = new ChoreographyEngine();
    const commands: Array<{ kind: string; actorId?: string; actionId?: string }> = [];
    engine.subscribe((command) => { commands.push(command); });
    const director = createOfficeDirector(engine, dormantClock());
    director.hydrate(officeSnapshot("scope-active", [participant("main", "main", "main", "idle")]), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    commands.length = 0;
    const terminal = officeSnapshot("scope-terminal", [participant("main", "main", "main", "completed")]);
    terminal.lifecycle = "terminal";
    terminal.residents = [resident("resident:memory", "planning")];

    director.sync(terminal, [{ kind: "scope-reset", previousContextId: "scope-active" }], false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands).toContainEqual(expect.objectContaining({ kind: "hideParticipant", actorId: "main" }));
    expect(commands).toContainEqual(expect.objectContaining({ actorId: "resident:memory", actionId: "working" }));
    expect(commands).not.toContainEqual(expect.objectContaining({ actorId: "main", actionId: expect.any(String) }));
    director.dispose();
  });

  it("turns off a station after its last occupant is removed", async () => {
    const engine = new ChoreographyEngine();
    const screens: Array<{ stationId: string; profile: string }> = [];
    engine.subscribe((command) => {
      if (command.kind === "setScreen") screens.push({ stationId: command.stationId, profile: command.profile });
    });
    const director = createOfficeDirector(engine, dormantClock());
    const main = participant("main", "main", "main", "idle");
    const child = participant("child-1", "child", "planning", "idle");
    director.hydrate(officeSnapshot("scope-1", [main, child]), false);
    await Promise.resolve();
    screens.length = 0;

    director.sync(officeSnapshot("scope-1", [main]), [
      { kind: "participant-removed", participantId: child.participantId },
    ], false);
    await Promise.resolve();

    expect(screens).toContainEqual({ stationId: "planning", profile: "off" });
    director.dispose();
  });

  it("commits only the latest detached office render generation", () => {
    const committed: string[] = [];
    const discarded: string[] = [];
    expect(commitLatestOfficeRender(2, 2, "new-scope", (value) => committed.push(value), (value) => discarded.push(value))).toBe(true);
    expect(commitLatestOfficeRender(1, 2, "old-scope", (value) => committed.push(value), (value) => discarded.push(value))).toBe(false);
    expect(committed).toEqual(["new-scope"]);
    expect(discarded).toEqual(["old-scope"]);
  });

  it("recolors only synchronized scarf-mask pixels", () => {
    const actor = new Uint8ClampedArray([
      201, 100, 66, 255,
      20, 20, 20, 255,
      245, 238, 214, 255,
    ]);
    const before = actor.slice();
    const mask = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    applyScarfMask(actor, mask, [2, 140, 255]);
    expect([...actor.slice(4)]).toEqual([...before.slice(4)]);
    expect([...actor.slice(0, 3)]).not.toEqual([...before.slice(0, 3)]);
  });

});

function snapshotWithStates(states: Array<"idle" | "working" | "completed">): OfficeExperienceSnapshot {
  const stations = resolver.stations().slice(0, states.length);
  return {
    contextId: "scope-1",
    revision: states.join("-"),
    lifecycle: "active",
    diagnostics: [],
    stations,
    residents: [],
    participants: states.map((state, index) => ({
      participantId: `actor-${index}`,
      navigationId: `actor-${index}`,
      stationId: stations[index]!.stationId,
      parentParticipantId: index === 0 ? null : "actor-0",
      kind: index === 0 ? "main" : "child",
      roleId: index === 0 ? "main" : "worker",
      label: `Actor ${index}`,
      createdAt: `2026-07-18T00:00:0${index}Z`,
      state,
      scarf: index === 0 ? "main" : "coder",
      presentationPreferences: preferences(),
    })),
  };
}

function snapshotWithoutDesk(states: Array<"idle" | "working" | "completed">): OfficeExperienceSnapshot {
  const snapshot = snapshotWithStates(states);
  for (const participant of snapshot.participants) participant.presentationPreferences.desk = [];
  return snapshot;
}

function participant(participantId: string, kind: "main" | "child", stationId: string, state: OfficeParticipant["state"]): OfficeParticipant {
  return {
    participantId,
    navigationId: participantId,
    stationId,
    parentParticipantId: kind === "main" ? null : "main",
    kind,
    roleId: kind === "main" ? "main-agent" : `${stationId}-agent`,
    label: participantId,
    createdAt: `2026-07-18T00:00:0${participantId.length}Z`,
    state,
    scarf: kind === "main" ? "main" : "coder",
    presentationPreferences: preferences(),
  };
}

function resident(residentId: string, stationId: string): OfficeExperienceSnapshot["residents"][number] {
  return {
    residentId,
    roleId: "harness-evolution-agent",
    label: "Harness Evolution Agent",
    stationId,
    scarf: "evolution",
    presentationPreferences: preferences(),
  };
}

function officeSnapshot(contextId: string, participants: OfficeParticipant[]): OfficeExperienceSnapshot {
  const stationIds = new Set(["main", "planning", "coder", "auditor"]);
  return {
    contextId,
    revision: `${contextId}:${participants.map((item) => item.participantId).join(",")}`,
    lifecycle: "active",
    diagnostics: [],
    stations: resolver.stations().filter((station) => stationIds.has(station.stationId)),
    residents: [],
    participants,
  };
}

function preferences(overrides: Partial<OfficePresentationPreferences> = {}): OfficePresentationPreferences {
  return {
    screens: [{ id: "game-1", weight: 1 }, { id: "game-2", weight: 1 }],
    desk: [{ id: "peek", weight: 1 }, { id: "drink-at-desk", weight: 1 }],
    facilities: [{ id: "coffee", weight: 1 }, { id: "treadmill", weight: 1 }, { id: "toilet", weight: 1 }],
    ...overrides,
  };
}

function ambientIntentId(intent: OfficeAmbientIntent): string {
  if (intent.kind === "desk") return intent.activity;
  if (intent.kind === "facility") return intent.facilityId;
  return intent.kind;
}

function flattenCommands(
  command: OfficeRuntimeVisualCommand,
): Array<Exclude<OfficeRuntimeVisualCommand, { kind: "sequence" | "parallel" }>> {
  if (command.kind !== "sequence" && command.kind !== "parallel") return [command];
  return command.commands.flatMap(flattenCommands);
}
