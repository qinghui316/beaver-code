import { describe, expect, it, vi } from "vitest";
import {
  setOfficeStationScreen,
} from "../../src/web/src/office/PixiOfficeRenderer.js";
import { applyOfficeActionVisual, applyOfficeParticipantDepth, applyOfficeParticipantRouteStage, OFFICE_RESIDENT_CROSSFADE_MS, officeActionOverlayGeometry, reconcileOfficeParticipants, shouldCrossFadeResidentReplacement } from "../../src/web/src/office/OfficeParticipantRenderer.js";
import type { OfficeSceneModel } from "../../src/web/src/office/officeScene.js";
import { OFFICE_SCREEN_ANIMATION_SPEED } from "../../src/web/src/office/officeVisualContract.js";

describe("Office renderer async mutations", () => {
  it("uses an exact short cross-fade only for resident removal plus real arrival", () => {
    const events = [
      { kind: "resident-removed" as const, residentId: "resident:harness-evolution-agent" },
      { kind: "participant-added" as const, participantId: "agent-1", parentParticipantId: "main-agent" },
    ];
    expect(OFFICE_RESIDENT_CROSSFADE_MS).toBe(160);
    expect(shouldCrossFadeResidentReplacement(events, false)).toBe(true);
    expect(shouldCrossFadeResidentReplacement(events, true)).toBe(false);
    expect(shouldCrossFadeResidentReplacement(events.slice(0, 1), false)).toBe(false);
  });

  it("releases a delayed actor asset without committing a stale render generation", async () => {
    const deferred = createDeferred<{ release: () => void }>();
    const lateRelease = vi.fn();
    const addChild = vi.fn();
    let currentGeneration = 1;
    const reconcile = reconcileOfficeParticipants(
      {} as never,
      { acquireAction: vi.fn(() => deferred.promise) } as never,
      { seatedActorLayer: { addChild }, mobileActorLayer: { addChild: vi.fn() } } as never,
      new Map(),
      sceneWithActor(),
      {} as never,
      {} as never,
      false,
      1,
      () => currentGeneration,
    );

    await Promise.resolve();
    currentGeneration = 2;
    deferred.resolve({ release: lateRelease });
    await reconcile;

    expect(lateRelease).toHaveBeenCalledOnce();
    expect(addChild).not.toHaveBeenCalled();
  });

  it("reparents one existing actor group between seated and mobile layers without rebuilding it", () => {
    const seated = actorLayer();
    const mobile = actorLayer();
    const group = { parent: seated };
    const visual = { depthMode: "seated", group };
    const actors = new Map([["agent-1", visual]]);
    const world = { seatedActorLayer: seated, mobileActorLayer: mobile };

    applyOfficeParticipantDepth(world as never, actors as never, { kind: "setActorDepth", actorId: "agent-1", mode: "mobile" });
    expect(mobile.addChild).toHaveBeenCalledWith(group);
    expect(visual.depthMode).toBe("mobile");
    expect(group.parent).toBe(mobile);

    applyOfficeParticipantDepth(world as never, actors as never, { kind: "setActorDepth", actorId: "agent-1", mode: "mobile" });
    expect(mobile.addChild).toHaveBeenCalledOnce();

    applyOfficeParticipantDepth(world as never, actors as never, { kind: "setActorDepth", actorId: "agent-1", mode: "seated" });
    expect(seated.addChild).toHaveBeenCalledWith(group);
    expect(visual.depthMode).toBe("seated");
  });

  it("does not relight a station when a cancelled ambient screen asset arrives late", async () => {
    const deferred = createDeferred<ReturnType<typeof screenHandle>>();
    const lateHandle = screenHandle();
    const currentHandle = screenHandle();
    const screen = screenSprite();
    const station = stationVisual(screen, currentHandle, "orchestration");
    const ambient = new AbortController();
    const assets = { acquireScreen: vi.fn(() => deferred.promise) };

    const pending = setOfficeStationScreen(assets as never, station as never, "entertainment-1", ambient.signal);
    await Promise.resolve();
    ambient.abort();
    await setOfficeStationScreen(assets as never, station as never, "off", new AbortController().signal);
    deferred.resolve(lateHandle);
    await pending;

    expect(screen.visible).toBe(false);
    expect(screen.gotoAndPlay).not.toHaveBeenCalled();
    expect(currentHandle.release).not.toHaveBeenCalled();
    expect(lateHandle.release).toHaveBeenCalledOnce();
    expect(station.screenProfile).toBe("orchestration");
  });

  it("commits a current station screen asset", async () => {
    const nextHandle = screenHandle();
    const currentHandle = screenHandle();
    const screen = screenSprite();
    const station = stationVisual(screen, currentHandle, "orchestration");

    await setOfficeStationScreen(
      { acquireScreen: vi.fn(async () => nextHandle) } as never,
      station as never,
      "entertainment-2",
      new AbortController().signal,
      0,
      false,
    );

    expect(currentHandle.release).toHaveBeenCalledOnce();
    expect(nextHandle.release).not.toHaveBeenCalled();
    expect(station.screenHandle).toBe(nextHandle);
    expect(station.screenProfile).toBe("entertainment-2");
    expect(screen.visible).toBe(true);
    expect(screen.animationSpeed).toBe(OFFICE_SCREEN_ANIMATION_SPEED);
    expect(screen.gotoAndPlay).toHaveBeenCalledWith(0);
  });

  it("keeps an occupied reduced-motion screen visible on a stable frame", async () => {
    const handle = screenHandle();
    const screen = screenSprite();
    const station = stationVisual(screen, handle, "orchestration");

    await setOfficeStationScreen(
      { acquireScreen: vi.fn() } as never,
      station as never,
      "orchestration",
      new AbortController().signal,
      0,
      true,
    );

    expect(screen.visible).toBe(true);
    expect(screen.gotoAndStop).toHaveBeenCalledWith(0);
    expect(screen.gotoAndPlay).not.toHaveBeenCalled();
  });

  it("does not restart an already playing screen when its profile is unchanged", async () => {
    const handle = screenHandle();
    const screen = screenSprite();
    const station = stationVisual(screen, handle, "entertainment-1");
    const assets = { acquireScreen: vi.fn() };

    await setOfficeStationScreen(
      assets as never,
      station as never,
      "entertainment-1",
      new AbortController().signal,
      0.75,
      false,
    );

    expect(assets.acquireScreen).not.toHaveBeenCalled();
    expect(screen.gotoAndPlay).not.toHaveBeenCalled();
    expect(screen.gotoAndStop).not.toHaveBeenCalled();
    expect(screen.play).not.toHaveBeenCalled();
  });

  it("resumes an unchanged visible screen without resetting its phase", async () => {
    const handle = screenHandle();
    const screen = screenSprite();
    screen.playing = false;
    const station = stationVisual(screen, handle, "orchestration");

    await setOfficeStationScreen(
      { acquireScreen: vi.fn() } as never,
      station as never,
      "orchestration",
      new AbortController().signal,
      0.75,
      false,
    );

    expect(screen.play).toHaveBeenCalledOnce();
    expect(screen.gotoAndPlay).not.toHaveBeenCalled();
  });

  it("plays looping working normally and freezes the same command for reduced motion", () => {
    const atlas = {
      animation: { fps: 12, loop: true },
      sheet: { animations: {} },
      officeProps: {},
    };
    const normal = actionSprite();
    normal.totalFrames = 4;
    applyOfficeActionVisual(normal as never, atlas as never, "working", { scale: 1, offset: { x: 0, y: 0 } }, false, false, 0.5, true);
    expect(normal.loop).toBe(true);
    expect(normal.gotoAndPlay).toHaveBeenCalledWith(2);
    expect(normal.gotoAndStop).not.toHaveBeenCalled();

    const reduced = actionSprite();
    reduced.totalFrames = 4;
    applyOfficeActionVisual(reduced as never, atlas as never, "working", { scale: 1, offset: { x: 0, y: 0 } }, false, true, 0.5, true);
    expect(reduced.loop).toBe(true);
    expect(reduced.gotoAndStop).toHaveBeenCalledWith(2);
    expect(reduced.gotoAndPlay).not.toHaveBeenCalled();
  });

  it("keeps route position and overlays unchanged until the next action is ready, then commits them together", async () => {
    const deferred = createDeferred<ReturnType<typeof actionHandle>>();
    const previous = actionHandle();
    const next = actionHandle({
      visualAnchor: { x: 274.5, y: 206 },
      firstFrameVisualBounds: {
        sourceSize: { width: 480, height: 480 },
        visibleRect: { x: 228.5, y: 94, width: 92.5, height: 112.5 },
      },
    });
    const group = positionedGroup(10, 20);
    const label = positionedLabel(3, -114, 100, 20);
    const status = { position: pointTarget(64.5, -124) };
    const visual = {
      actor: { actorId: "agent-1", scarf: "main" },
      actionId: "working",
      group,
      sprite: actionSprite(),
      label,
      statusIndicator: status,
      actionHandle: previous,
      overlayReference: { centerX: 0, top: -70 },
      labelBasePosition: { x: 3, y: -114 },
    };
    const command = {
      kind: "playRouteStage" as const,
      actorId: "agent-1",
      routeId: "canonical-seat",
      actionId: "toilet" as const,
      points: [{ x: -40, y: 511 }],
      durationMs: 0,
    };
    const pending = applyOfficeParticipantRouteStage(
      { acquireAction: vi.fn(() => deferred.promise) } as never,
      new Map([["agent-1", visual as never]]),
      { action: vi.fn(() => ({ scale: 0.965, offset: { x: 260.4, y: 243.6 } })) } as never,
      command,
      new AbortController().signal,
      false,
    );

    expect({ x: group.x, y: group.y, labelX: label.x, labelY: label.y }).toEqual({ x: 10, y: 20, labelX: 3, labelY: -114 });
    deferred.resolve(next);
    await pending;

    expect({ x: group.x, y: group.y }).toEqual({ x: -40, y: 511 });
    expect(label.x).toBeCloseTo(263.6, 1);
    expect(label.y).toBeCloseTo(91.5, 1);
    expect(status.position.x).toBeCloseTo(label.x + 61.5, 1);
    expect(status.position.y).toBeCloseTo(label.y - 10, 1);
    expect(previous.release).toHaveBeenCalledOnce();
    expect(next.release).not.toHaveBeenCalled();
  });

  it("releases a cancelled route-stage action without moving the actor or its overlays", async () => {
    const deferred = createDeferred<ReturnType<typeof actionHandle>>();
    const next = actionHandle();
    const controller = new AbortController();
    const group = positionedGroup(10, 20);
    const label = positionedLabel(3, -114, 100, 20);
    const visual = {
      actor: { actorId: "agent-1", scarf: "main" },
      group,
      label,
    };
    const pending = applyOfficeParticipantRouteStage(
      { acquireAction: vi.fn(() => deferred.promise) } as never,
      new Map([["agent-1", visual as never]]),
      {} as never,
      { kind: "playRouteStage", actorId: "agent-1", routeId: "walk-out", actionId: "walk-horizontal", points: [{ x: 30, y: 40 }], durationMs: 100 },
      controller.signal,
      false,
    );
    controller.abort();
    deferred.resolve(next);
    await pending;

    expect({ x: group.x, y: group.y, labelX: label.x, labelY: label.y }).toEqual({ x: 10, y: 20, labelX: 3, labelY: -114 });
    expect(next.release).toHaveBeenCalledOnce();
  });

  it("derives overlay geometry from the visible action bounds without changing route coordinates", () => {
    const geometry = officeActionOverlayGeometry({
      visualAnchor: { x: 274.5, y: 206 },
      firstFrameVisualBounds: {
        sourceSize: { width: 480, height: 480 },
        visibleRect: { x: 228.5, y: 94, width: 92.5, height: 112.5 },
      },
    } as never, { scale: 0.965, offset: { x: 260.4, y: 243.6 } }, false);
    expect(geometry.centerX).toBeCloseTo(260.64125, 5);
    expect(geometry.top).toBeCloseTo(135.52, 5);
  });
});

function sceneWithActor(): OfficeSceneModel {
  return {
    conversationId: "conversation-1",
    graphScopeId: "scope-1",
    projectionHash: "projection-1",
    scopeStatus: "active",
    width: 100,
    height: 100,
    stations: [],
    zones: [],
    events: [],
    diagnostics: [],
    actors: [{
      actorId: "agent-1",
      seatId: "planning",
      navigationId: "agent-1",
      kind: "agent",
      roleId: "planning-agent",
      label: "Planning Agent",
      status: "idle",
      parentActorId: "main-agent",
      workstation: { x: 0, y: 0 },
      anchors: {
        seat: { x: 10, y: 20 },
        handoff: { x: 10, y: 20 },
        facilityDeparture: { x: 10, y: 20 },
      },
      scarf: "blue",
      createdAt: "2026-07-25T00:00:00.000Z",
    }],
  };
}

function screenHandle() {
  return {
    asset: {
      animationId: "screen",
      animation: { fps: 12 },
      sheet: { animations: { screen: ["frame-1"] } },
    },
    release: vi.fn(),
  };
}

function screenSprite() {
  return {
    visible: true,
    playing: true,
    textures: ["old-frame"],
    totalFrames: 1,
    animationSpeed: 0,
    width: 0,
    height: 0,
    stop: vi.fn(),
    play: vi.fn(),
    gotoAndStop: vi.fn(),
    gotoAndPlay: vi.fn(),
  };
}

function stationVisual(screen: ReturnType<typeof screenSprite>, handle: ReturnType<typeof screenHandle>, profile: string) {
  return {
    station: { stationId: "planning" },
    screen,
    screenHandle: handle,
    screenProfile: profile,
    screenWidth: 100,
    screenHeight: 50,
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function actionHandle(overrides: Record<string, unknown> = {}) {
  return {
    asset: {
      animationId: "action",
      animation: { fps: 12, loop: false },
      sheet: { animations: { action: [{}] } },
      officeProps: {},
      ...overrides,
    },
    release: vi.fn(),
  };
}

function pointTarget(x = 0, y = 0) {
  return {
    x,
    y,
    set(nextX: number, nextY: number) {
      this.x = nextX;
      this.y = nextY;
    },
  };
}

function actionSprite() {
  const position = pointTarget();
  return {
    textures: [],
    texture: { orig: { width: 480, height: 480 } },
    anchor: { set: vi.fn() },
    pivot: { set: vi.fn() },
    position,
    scale: { set: vi.fn() },
    totalFrames: 1,
    animationSpeed: 0,
    loop: false,
    gotoAndStop: vi.fn(),
    gotoAndPlay: vi.fn(),
  };
}

function positionedLabel(x: number, y: number, width: number, height: number) {
  const position = pointTarget(x, y);
  return {
    get x() { return position.x; },
    get y() { return position.y; },
    width,
    height,
    position,
  };
}

function positionedGroup(x: number, y: number) {
  const position = pointTarget(x, y);
  return {
    get x() { return position.x; },
    get y() { return position.y; },
    position,
  };
}

function actorLayer() {
  return {
    addChild: vi.fn(function addChild(this: unknown, child: { parent: unknown }) {
      child.parent = this;
      return child;
    }),
  };
}
