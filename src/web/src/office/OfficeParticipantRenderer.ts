import type { AnimatedSprite, Container, Graphics, Text, Texture } from "pixi.js";
import type { OfficeAtlasHandle } from "./officeAssetLoader.js";
import { officeActorStatusLocalPosition } from "./officeActorLabel.js";
import type { OfficeCalibrationDocument } from "./officeCalibrationDocument.js";
import type { OfficeCalibrationResolver } from "./officeCalibrationResolver.js";
import { addOfficeActorLabel } from "./officePixiComposition.js";
import { commitLatestOfficeRender } from "./officeRenderGeneration.js";
import { officeRouteFrameAt } from "./officeRouteInterpolation.js";
import { OfficeRuntimeAssets, type ParsedOfficeAtlas } from "./officeRuntimeAssets.js";
import type { OfficeActor, OfficeActorStatus, OfficeSceneModel } from "./officeScene.js";
import type { OfficeStaticWorld } from "./OfficeStaticSceneRenderer.js";
import { officeActionPlaybackRate, type OfficeActionId, type OfficeActorDepthMode, type OfficePoint, type OfficeRuntimeVisualCommand } from "./officeVisualContract.js";

type PixiModule = typeof import("pixi.js");

export const OFFICE_RESIDENT_CROSSFADE_MS = 160;

export type OfficeActorVisual = {
  actor: OfficeActor;
  actionId: OfficeActionId;
  depthMode: OfficeActorDepthMode;
  group: Container;
  sprite: AnimatedSprite;
  label: Text | null;
  statusIndicator: Graphics;
  actionHandle: OfficeAtlasHandle<ParsedOfficeAtlas>;
  overlayReference: OfficeActionOverlayGeometry;
  labelBasePosition: OfficePoint | null;
};

export type OfficeActionOverlayGeometry = {
  centerX: number;
  top: number;
};

const STATUS_COLORS: Record<OfficeActorStatus, number> = {
  idle: 0x8a8f98,
  queued: 0x7a667f,
  working: 0x3b6ea8,
  completed: 0x2f7d68,
  blocked: 0xb8872f,
  failed: 0xb84b45,
  attention: 0xc9823c,
  interrupted: 0x747981,
};

export async function reconcileOfficeParticipants(
  pixi: PixiModule,
  assets: OfficeRuntimeAssets,
  world: OfficeStaticWorld,
  visuals: Map<string, OfficeActorVisual>,
  scene: OfficeSceneModel,
  calibration: Readonly<OfficeCalibrationDocument>,
  resolver: OfficeCalibrationResolver,
  reducedMotion: boolean,
  generation: number,
  currentGeneration: () => number,
): Promise<void> {
  const prepared: OfficeActorVisual[] = [];
  const residentReplacement = shouldCrossFadeResidentReplacement(scene.events, reducedMotion);
  try {
    for (const actor of scene.actors) {
      if (visuals.has(actor.actorId)) continue;
      const actionId = "working";
      const handle = await assets.acquireAction(actionId, actor.scarf, `actor:${actor.actorId}`, "bootstrap");
      if (generation !== currentGeneration()) {
        handle.release();
        destroyPrepared(prepared);
        return;
      }
      const frames = handle.asset.animationId ? handle.asset.sheet.animations[handle.asset.animationId] ?? [] : [];
      if (frames.length === 0) {
        handle.release();
        throw new Error(`Office action ${actionId} has no frames.`);
      }
      const group = new pixi.Container();
      group.position.set(actor.anchors.seat.x, actor.anchors.seat.y);
      if (residentReplacement && actor.kind !== "resident") group.alpha = 0;
      const sprite = new pixi.AnimatedSprite(frames);
      applyActionVisual(sprite, handle.asset, actionId, resolver.action(actionId), false, reducedMotion, 0, true);
      group.addChild(sprite);
      const station = scene.stations.find((candidate) => candidate.stationId === actor.seatId);
      if (!station) throw new Error(`Office actor ${actor.actorId} has no station ${actor.seatId}.`);
      const template = calibration.stationTemplates[station.workstationKind];
      if (!template) throw new Error(`Office station template ${station.workstationKind} is missing.`);
      const label = addOfficeActorLabel(pixi, group, actor.label, station.workstationKind, template, resolver.action(actionId).scale);
      const indicator = new pixi.Graphics();
      const indicatorPosition = label
        ? officeActorStatusLocalPosition({ x: label.x, y: label.y }, label.width, label.height)
        : { x: 56, y: -128 };
      indicator.position.set(indicatorPosition.x, indicatorPosition.y);
      drawStatusIndicator(indicator, actor.status);
      group.addChild(indicator);
      prepared.push({
        actor,
        actionId,
        depthMode: "seated",
        group,
        sprite,
        label,
        statusIndicator: indicator,
        actionHandle: handle,
        overlayReference: officeActionOverlayGeometry(handle.asset, resolver.action(actionId), false),
        labelBasePosition: label ? { x: label.x, y: label.y } : null,
      });
    }
  } catch (error) {
    destroyPrepared(prepared);
    throw error;
  }

  commitLatestOfficeRender(generation, currentGeneration(), prepared, (current) => {
    const nextIds = new Set(scene.actors.map((actor) => actor.actorId));
    const outgoingResidents: OfficeActorVisual[] = [];
    for (const [actorId, visual] of visuals) {
      if (nextIds.has(actorId)) continue;
      visuals.delete(actorId);
      if (residentReplacement && visual.actor.kind === "resident") outgoingResidents.push(visual);
      else destroyVisual(visual);
    }
    for (const actor of scene.actors) {
      const existing = visuals.get(actor.actorId);
      if (!existing) continue;
      existing.actor = actor;
      drawStatusIndicator(existing.statusIndicator, actor.status);
    }
    for (const visual of current) {
      world.seatedActorLayer.addChild(visual.group);
      visuals.set(visual.actor.actorId, visual);
    }
    if (residentReplacement) {
      const incomingParticipants = current.filter((visual) => visual.actor.kind !== "resident");
      runResidentCrossFade(outgoingResidents, incomingParticipants, generation, currentGeneration);
    } else {
      for (const visual of current) visual.group.alpha = 1;
      for (const visual of outgoingResidents) destroyVisual(visual);
    }
  }, destroyPrepared);
}

export function applyOfficeParticipantDepth(
  world: OfficeStaticWorld,
  visuals: Map<string, OfficeActorVisual>,
  command: Extract<OfficeRuntimeVisualCommand, { kind: "setActorDepth" }>,
): void {
  const visual = visuals.get(command.actorId);
  if (!visual) return;
  const target = command.mode === "seated" ? world.seatedActorLayer : world.mobileActorLayer;
  if (visual.depthMode === command.mode && visual.group.parent === target) return;
  target.addChild(visual.group);
  visual.depthMode = command.mode;
}

export function shouldCrossFadeResidentReplacement(events: OfficeSceneModel["events"], reducedMotion: boolean): boolean {
  return !reducedMotion
    && events.some((event) => event.kind === "resident-removed")
    && events.some((event) => event.kind === "participant-added");
}

export async function applyOfficeParticipantAction(
  assets: OfficeRuntimeAssets,
  visuals: Map<string, OfficeActorVisual>,
  resolver: OfficeCalibrationResolver,
  command: Extract<OfficeRuntimeVisualCommand, { kind: "playAction" }>,
  signal: AbortSignal,
  reducedMotion: boolean,
): Promise<void> {
  const visual = visuals.get(command.actorId);
  if (!visual) return;
  const handle = await assets.acquireAction(command.actionId, visual.actor.scarf, `runtime:${visual.actor.actorId}`, "semantic");
  if (signal.aborted) return handle.release();
  const frames = handle.asset.animationId ? handle.asset.sheet.animations[handle.asset.animationId] ?? [] : [];
  if (frames.length === 0) { handle.release(); return; }
  commitOfficeParticipantAction(visual, handle, frames, resolver, command, reducedMotion);
}

export async function applyOfficeParticipantRouteStage(
  assets: OfficeRuntimeAssets,
  visuals: Map<string, OfficeActorVisual>,
  resolver: OfficeCalibrationResolver,
  command: Extract<OfficeRuntimeVisualCommand, { kind: "playRouteStage" }>,
  signal: AbortSignal,
  reducedMotion: boolean,
): Promise<void> {
  const visual = visuals.get(command.actorId);
  if (!visual) return;
  const handle = await assets.acquireAction(command.actionId, visual.actor.scarf, `runtime:${visual.actor.actorId}`, "semantic");
  if (signal.aborted) return handle.release();
  const frames = handle.asset.animationId ? handle.asset.sheet.animations[handle.asset.animationId] ?? [] : [];
  if (frames.length === 0) { handle.release(); return; }

  if (command.points.length > 0) {
    const start = reducedMotion ? command.points.at(-1)! : command.points[0]!;
    visual.group.position.set(start.x, start.y);
  }
  commitOfficeParticipantAction(visual, handle, frames, resolver, command, reducedMotion);

  if (reducedMotion || command.durationMs <= 0) return;
  if (command.points.length <= 1) return abortableDelay(command.durationMs, signal);
  await followOfficeParticipantRoute(visual.group, command.points, command.durationMs, signal, false, true);
}

export function destroyOfficeParticipants(actors: Map<string, OfficeActorVisual>): void {
  for (const visual of actors.values()) {
    visual.actionHandle.release();
    visual.group.destroy({ children: true });
  }
}

export function applyOfficeActionVisual(
  sprite: AnimatedSprite,
  atlas: ParsedOfficeAtlas,
  actionId: OfficeActionId,
  alignment: { scale: number; offset: OfficePoint },
  flipX: boolean,
  reducedMotion: boolean,
  phase: number,
  loop = atlas.animation.loop,
  timed = false,
): void {
  applyActionVisual(sprite, atlas, actionId, alignment, flipX, reducedMotion, phase, loop, timed);
}

export function officeActionOverlayGeometry(
  atlas: ParsedOfficeAtlas,
  alignment: { scale: number; offset: OfficePoint },
  flipX: boolean,
): OfficeActionOverlayGeometry {
  const bounds = atlas.firstFrameVisualBounds;
  if (!bounds) return { centerX: alignment.offset.x, top: alignment.offset.y };
  const anchor = atlas.visualAnchor ?? {
    x: bounds.sourceSize.width / 2,
    y: bounds.sourceSize.height,
  };
  const centerInCanvas = bounds.visibleRect.x + bounds.visibleRect.width / 2;
  return {
    centerX: alignment.offset.x + (centerInCanvas - anchor.x) * alignment.scale * (flipX ? -1 : 1),
    top: alignment.offset.y + (bounds.visibleRect.y - anchor.y) * alignment.scale,
  };
}

export function followOfficeParticipantRoute(
  group: Container | undefined,
  points: readonly OfficePoint[],
  durationMs: number,
  signal: AbortSignal,
  reducedMotion: boolean,
  startAlreadyCommitted = false,
): Promise<void> {
  if (!group || points.length === 0) return Promise.resolve();
  if (reducedMotion || durationMs <= 0 || points.length === 1) {
    group.position.set(points.at(-1)!.x, points.at(-1)!.y);
    return Promise.resolve();
  }
  if (!startAlreadyCommitted) group.position.set(points[0]!.x, points[0]!.y);
  return new Promise((resolve) => {
    const started = performance.now();
    const step = (now: number) => {
      if (signal.aborted) return resolve();
      const frame = officeRouteFrameAt(points, now - started, durationMs);
      if (!frame) return resolve();
      group.position.set(frame.position.x, frame.position.y);
      if (frame.progress < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

function commitOfficeParticipantAction(
  visual: OfficeActorVisual,
  handle: OfficeAtlasHandle<ParsedOfficeAtlas>,
  frames: Texture[],
  resolver: OfficeCalibrationResolver,
  command: Extract<OfficeRuntimeVisualCommand, { kind: "playAction" | "playRouteStage" }>,
  reducedMotion: boolean,
): void {
  const previous = visual.actionHandle;
  const alignment = resolver.action(command.actionId);
  visual.actionHandle = handle;
  visual.sprite.textures = command.reverse ? [...frames].reverse() : frames;
  applyActionVisual(visual.sprite, handle.asset, command.actionId, alignment, command.flipX ?? false, reducedMotion, "phase" in command ? command.phase ?? 0 : 0, command.loop, command.durationMs != null);
  applyActorOverlayPlacement(visual, officeActionOverlayGeometry(handle.asset, alignment, command.flipX ?? false));
  visual.actionId = command.actionId;
  previous.release();
}

function applyActorOverlayPlacement(visual: OfficeActorVisual, current: OfficeActionOverlayGeometry): void {
  const base = visual.labelBasePosition;
  if (!visual.label || !base) return;
  visual.label.position.set(
    base.x + current.centerX - visual.overlayReference.centerX,
    base.y + current.top - visual.overlayReference.top,
  );
  const indicator = officeActorStatusLocalPosition(
    { x: visual.label.x, y: visual.label.y },
    visual.label.width,
    visual.label.height,
  );
  visual.statusIndicator.position.set(indicator.x, indicator.y);
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = globalThis.setTimeout(resolve, durationMs);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function applyActionVisual(sprite: AnimatedSprite, atlas: ParsedOfficeAtlas, actionId: OfficeActionId, alignment: { scale: number; offset: OfficePoint }, flipX: boolean, reducedMotion: boolean, phase: number, loop = atlas.animation.loop, timed = false): void {
  if (atlas.visualAnchor) sprite.anchor.set(atlas.visualAnchor.x / sprite.texture.orig.width, atlas.visualAnchor.y / sprite.texture.orig.height);
  else sprite.anchor.set(0.5, 1);
  sprite.pivot.set(0, 0);
  sprite.position.set(alignment.offset.x, alignment.offset.y);
  sprite.scale.set((flipX ? -1 : 1) * alignment.scale, alignment.scale);
  sprite.animationSpeed = Math.max(0.03, atlas.animation.fps / 60) * officeActionPlaybackRate(actionId);
  sprite.loop = loop;
  const frame = Math.min(sprite.totalFrames - 1, Math.floor(phase * sprite.totalFrames));
  if (reducedMotion || (!loop && !timed)) sprite.gotoAndStop(frame); else sprite.gotoAndPlay(frame);
}

function drawStatusIndicator(graphics: Graphics, status: OfficeActorStatus): void {
  graphics.clear().circle(0, 0, 6).fill(STATUS_COLORS[status]).stroke({ color: 0xfaf9f7, width: 2 });
  graphics.visible = status === "attention" || status === "blocked" || status === "failed" || status === "interrupted";
}

function destroyPrepared(actors: OfficeActorVisual[]): void {
  for (const visual of actors) destroyVisual(visual);
}

function runResidentCrossFade(
  outgoing: OfficeActorVisual[],
  incoming: OfficeActorVisual[],
  generation: number,
  currentGeneration: () => number,
): void {
  const started = performance.now();
  const frame = (now: number) => {
    const progress = Math.min(1, Math.max(0, (now - started) / OFFICE_RESIDENT_CROSSFADE_MS));
    for (const visual of outgoing) visual.group.alpha = 1 - progress;
    for (const visual of incoming) visual.group.alpha = progress;
    if (progress < 1 && generation === currentGeneration()) {
      scheduleFrame(frame);
      return;
    }
    for (const visual of outgoing) destroyVisual(visual);
    for (const visual of incoming) visual.group.alpha = 1;
  };
  scheduleFrame(frame);
}

function scheduleFrame(callback: FrameRequestCallback): void {
  if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(callback);
  else globalThis.setTimeout(() => callback(performance.now()), 16);
}

function destroyVisual(visual: OfficeActorVisual): void {
  visual.actionHandle.release();
  visual.group.destroy({ children: true });
}
