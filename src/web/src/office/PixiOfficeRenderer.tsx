import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type WheelEvent as ReactWheelEvent } from "react";
import type { Application, Container } from "pixi.js";
import { ChoreographyEngine } from "./choreographyEngine.js";
import { OfficeDirector } from "./officeDirector.js";
import type { OfficeActivityCompiler } from "./officeActivityCompiler.js";
import type { OfficeBehaviorPolicy } from "./officeBehaviorPolicy.js";
import type { OfficeAmbientPolicy } from "./officeAmbientPolicy.js";
import type { OfficeCalibrationDocument } from "./officeCalibrationDocument.js";
import type { OfficeCalibrationResolver } from "./officeCalibrationResolver.js";
import { OfficeRuntimeAssets, type OfficeScreenProfile, type ParsedOfficeAtlas } from "./officeRuntimeAssets.js";
import type { OfficeAtlasHandle } from "./officeAssetLoader.js";
import { type OfficeActor, type OfficeActorStatus, type OfficeSceneModel } from "./officeScene.js";
import { destroyOfficeStaticWorld, OfficeStaticSceneRenderer, type OfficeStaticWorld, type OfficeStationVisual as StationVisual } from "./OfficeStaticSceneRenderer.js";
import { OfficeLoadingScreen } from "./OfficeLoadingScreen.js";
import { removeOfficeTickerIfCurrent } from "./officeRendererLifecycle.js";
import { applyOfficeActionVisual, applyOfficeParticipantAction, applyOfficeParticipantDepth, applyOfficeParticipantRouteStage, destroyOfficeParticipants, followOfficeParticipantRoute, reconcileOfficeParticipants, type OfficeActorVisual } from "./OfficeParticipantRenderer.js";
import { OFFICE_SCREEN_ANIMATION_SPEED } from "./officeVisualContract.js";
import { loadOfficePixiModule } from "./officePixiRuntime.js";
import { createOfficeRendererFailure, reportOfficeRendererFailure, type OfficeRendererFailure } from "./officeRendererDiagnostic.js";

type PixiModule = typeof import("pixi.js");
type Camera = { x: number; y: number; zoom: number };
type RendererState = "loading" | "ready" | "fallback";
type LoaderVisual = { container: Container; handle: OfficeAtlasHandle<ParsedOfficeAtlas> };

export function PixiOfficeRenderer({ scene, calibration, resolver, behavior, ambient, activities, selectedActorId, onSelectActor, onViewportInteraction }: {
  scene: OfficeSceneModel;
  calibration: Readonly<OfficeCalibrationDocument>;
  resolver: OfficeCalibrationResolver;
  behavior: OfficeBehaviorPolicy;
  ambient: OfficeAmbientPolicy;
  activities: OfficeActivityCompiler;
  selectedActorId: string | null;
  onSelectActor: (actorId: string, anchor: { x: number; y: number }) => void;
  onViewportInteraction?: () => void;
}): ReactElement {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const pixiRef = useRef<PixiModule | null>(null);
  const sceneRootRef = useRef<Container | null>(null);
  const worldRef = useRef<OfficeStaticWorld | null>(null);
  const actorsRef = useRef(new Map<string, OfficeActorVisual>());
  const assetsRef = useRef<OfficeRuntimeAssets | null>(null);
  const engineRef = useRef(new ChoreographyEngine());
  const directorRef = useRef(new OfficeDirector(engineRef.current, resolver, behavior, activities, undefined, undefined, ambient));
  const hydratedContextRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const tickerRef = useRef<((ticker: { lastTime: number }) => void) | null>(null);
  const reducedMotionRef = useRef(false);
  const [rendererState, setRendererState] = useState<RendererState>("loading");
  const [rendererFailure, setRendererFailure] = useState<OfficeRendererFailure | null>(null);
  const [loadProgress, setLoadProgress] = useState(10);
  const [retryVersion, setRetryVersion] = useState(0);
  const [camera, setCamera] = useState<Camera>({ x: 24, y: 24, zoom: 1 });
  const [dragging, setDragging] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const dragRef = useRef({ x: 0, y: 0, cameraX: 0, cameraY: 0 });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number; centerX: number; centerY: number; cameraX: number; cameraY: number } | null>(null);
  const cameraTouchedRef = useRef(false);
  const firstRenderCompleteRef = useRef(false);
  const loadingFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadingVisible, setLoadingVisible] = useState(true);
  reducedMotionRef.current = reducedMotion;

  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const zoom = clamp(Math.min((viewport.clientWidth - 48) / scene.width, (viewport.clientHeight - 48) / scene.height), 0.28, 1.35);
    setCamera({ zoom, x: Math.round((viewport.clientWidth - scene.width * zoom) / 2), y: Math.round((viewport.clientHeight - scene.height * zoom) / 2) });
  }, [scene.height, scene.width]);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    if (globalThis.navigator?.userAgent.includes("jsdom")) {
      setRendererState("fallback");
      return;
    }
    let disposed = false;
    let canvas: HTMLCanvasElement | null = null;
    let pendingApp: Application | null = null;
    let removeContextListener: (() => void) | null = null;
    setRendererState("loading");
    setRendererFailure(null);
    firstRenderCompleteRef.current = false;
    setLoadingVisible(true);
    setLoadProgress(24);
    const initialize = async () => {
      const pixi = await loadOfficePixiModule();
      const app = new pixi.Application();
      pendingApp = app;
      try {
        await app.init({ background: "#faf9f7", antialias: true, autoDensity: true, resolution: Math.min(2, globalThis.devicePixelRatio || 1), resizeTo: host, preference: "webgl" });
      } catch (error) {
        destroyOfficeApplication(app);
        pendingApp = null;
        throw error;
      }
      if (disposed) {
        destroyOfficeApplication(app);
        pendingApp = null;
        return;
      }
      const root = new pixi.Container();
      app.stage.addChild(root);
      host.replaceChildren(app.canvas);
      canvas = app.canvas;
      const onLost = (event: Event) => {
        event.preventDefault();
        const failure = createOfficeRendererFailure("context-lost");
        setRendererFailure(failure);
        reportOfficeRendererFailure(failure);
        setRendererState("fallback");
      };
      canvas.addEventListener("webglcontextlost", onLost);
      removeContextListener = () => canvas?.removeEventListener("webglcontextlost", onLost);
      appRef.current = app;
      pendingApp = null;
      pixiRef.current = pixi;
      sceneRootRef.current = root;
      assetsRef.current = new OfficeRuntimeAssets(pixi, chooseResolution(host));
      setLoadProgress(40);
      setRendererState("ready");
    };
    void initialize().catch((error: unknown) => {
      if (disposed) return;
      const failure = createOfficeRendererFailure("application-init", error);
      setRendererFailure(failure);
      reportOfficeRendererFailure(failure);
      setRendererState("fallback");
    });
    return () => {
      disposed = true;
      removeContextListener?.();
      if (loadingFadeTimerRef.current) globalThis.clearTimeout(loadingFadeTimerRef.current);
      generationRef.current += 1;
      engineRef.current.resetScope();
      hydratedContextRef.current = null;
      destroyOfficeParticipants(actorsRef.current);
      actorsRef.current.clear();
      destroyOfficeStaticWorld(worldRef.current);
      worldRef.current = null;
      assetsRef.current?.dispose();
      assetsRef.current = null;
      const app = appRef.current;
      if (app && tickerRef.current) app.ticker.remove(tickerRef.current);
      appRef.current = null;
      pixiRef.current = null;
      sceneRootRef.current = null;
      tickerRef.current = null;
      destroyOfficeApplication(app);
      if (pendingApp && pendingApp !== app) destroyOfficeApplication(pendingApp);
      pendingApp = null;
      host.replaceChildren();
      canvas = null;
    };
  }, [retryVersion]);

  useEffect(() => engineRef.current.subscribe((command, signal) => {
    const pixi = pixiRef.current;
    const assets = assetsRef.current;
    const world = worldRef.current;
    if (!pixi || !assets || !world) return;
    if (command.kind === "setActorDepth") return applyOfficeParticipantDepth(world, actorsRef.current, command);
    if (command.kind === "playAction") return applyOfficeParticipantAction(assets, actorsRef.current, resolver, command, signal, reducedMotionRef.current);
    if (command.kind === "playRouteStage") return applyOfficeParticipantRouteStage(assets, actorsRef.current, resolver, command, signal, reducedMotionRef.current);
    if (command.kind === "followRoute") return followOfficeParticipantRoute(actorsRef.current.get(command.actorId)?.group, command.points, command.durationMs, signal, reducedMotionRef.current);
    if (command.kind === "setScreen") return setOfficeStationScreen(assets, world.stations.get(command.stationId), command.profile, signal, command.phase, reducedMotionRef.current);
    if (command.kind === "setEffect") return setActorEffect(command.actorId, actorsRef.current.get(command.actorId), world, command.effect, reducedMotionRef.current);
    const visual = actorsRef.current.get(command.actorId);
    if (visual) visual.group.visible = command.kind === "showParticipant";
  }), []);

  useEffect(() => {
    if (rendererState !== "ready" || !pixiRef.current || !sceneRootRef.current || !assetsRef.current) return;
    let cancelled = false;
    const generation = ++generationRef.current;
    const prepare = async () => {
      let world = worldRef.current;
      if (!world) {
        const loader = await createLoaderVisual(pixiRef.current!, assetsRef.current!, calibration, reducedMotion).catch(() => null);
        if (loader) sceneRootRef.current!.addChild(loader.container);
        if (!firstRenderCompleteRef.current) setLoadProgress(55);
        try {
          world = await new OfficeStaticSceneRenderer(pixiRef.current!, assetsRef.current!, calibration).build(scene, reducedMotion);
        } finally {
          if (loader) {
            loader.container.removeFromParent();
            loader.container.destroy({ children: true });
            loader.handle.release();
          }
        }
        if (cancelled || generation !== generationRef.current) return destroyOfficeStaticWorld(world);
        sceneRootRef.current!.addChild(world.root);
        worldRef.current = world;
        if (!firstRenderCompleteRef.current) setLoadProgress(75);
      }
      await reconcileOfficeParticipants(
        pixiRef.current!,
        assetsRef.current!,
        world,
        actorsRef.current,
        scene,
        calibration,
        resolver,
        reducedMotion,
        generation,
        () => generationRef.current,
      );
      if (cancelled || generation !== generationRef.current) return;
      if (!firstRenderCompleteRef.current) setLoadProgress(92);
      if (hydratedContextRef.current === null) {
        directorRef.current.hydrate(scene.experience, reducedMotion);
      } else {
        directorRef.current.sync(scene.experience, scene.events, reducedMotion);
      }
      hydratedContextRef.current = scene.graphScopeId;
      if (!firstRenderCompleteRef.current) {
        firstRenderCompleteRef.current = true;
        setLoadProgress(100);
        loadingFadeTimerRef.current = globalThis.setTimeout(() => {
          if (!cancelled) setLoadingVisible(false);
        }, 160);
      }
    };
    void prepare().catch((error: unknown) => {
      if (!cancelled && (!(error instanceof DOMException) || error.name !== "AbortError")) {
        const failure = createOfficeRendererFailure("scene-build", error);
        setRendererFailure(failure);
        reportOfficeRendererFailure(failure);
        setRendererState("fallback");
      }
    });
    const app = appRef.current!;
    if (tickerRef.current) app.ticker.remove(tickerRef.current);
    const ticker = () => {
      if (document.hidden) return;
      for (const actor of scene.actors) {
        const visual = actorsRef.current.get(actor.actorId);
        const hitbox = viewportRef.current?.querySelector<HTMLElement>(`[data-office-actor="${CSS.escape(actor.actorId)}"]`);
        if (visual && hitbox) {
          hitbox.style.left = `${visual.group.x - 68}px`;
          hitbox.style.top = `${visual.group.y - 170}px`;
        }
      }
    };
    tickerRef.current = ticker;
    app.ticker.add(ticker);
    return () => {
      cancelled = true;
      if (generationRef.current === generation) generationRef.current += 1;
      removeOfficeTickerIfCurrent(app, appRef.current, ticker, tickerRef.current);
    };
  }, [calibration, reducedMotion, rendererState, resolver, scene]);

  useEffect(() => {
    if (!sceneRootRef.current) return;
    sceneRootRef.current.position.set(camera.x, camera.y);
    sceneRootRef.current.scale.set(camera.zoom);
  }, [camera, rendererState]);

  useEffect(() => { cameraTouchedRef.current = false; fitToView(); }, [fitToView, scene.graphScopeId]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (!cameraTouchedRef.current) fitToView(); });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitToView]);
  useEffect(() => {
    const onVisibility = () => directorRef.current.visibilityChanged(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => () => directorRef.current.dispose(), []);

  const overlayTransform = useMemo(() => `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`, [camera]);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    onViewportInteraction?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()];
      pinchRef.current = { distance: Math.hypot(second!.x - first!.x, second!.y - first!.y), zoom: camera.zoom, centerX: (first!.x + second!.x) / 2, centerY: (first!.y + second!.y) / 2, cameraX: camera.x, cameraY: camera.y };
      return;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y };
    setDragging(true);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const [first, second] = [...pointersRef.current.values()];
      const centerX = (first!.x + second!.x) / 2;
      const centerY = (first!.y + second!.y) / 2;
      const zoom = clamp(pinchRef.current.zoom * Math.hypot(second!.x - first!.x, second!.y - first!.y) / Math.max(1, pinchRef.current.distance), 0.28, 2);
      const ratio = zoom / pinchRef.current.zoom;
      setCamera({ zoom, x: centerX - (pinchRef.current.centerX - pinchRef.current.cameraX) * ratio, y: centerY - (pinchRef.current.centerY - pinchRef.current.cameraY) * ratio });
      return;
    }
    if (dragging) setCamera((value) => ({ ...value, x: dragRef.current.cameraX + event.clientX - dragRef.current.x, y: dragRef.current.cameraY + event.clientY - dragRef.current.y }));
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
    setDragging(false);
  };
  const wheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    onViewportInteraction?.();
    cameraTouchedRef.current = true;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setCamera((value) => {
      const zoom = clamp(value.zoom * (event.deltaY > 0 ? 0.9 : 1.1), 0.28, 2);
      const ratio = zoom / value.zoom;
      return { zoom, x: x - (x - value.x) * ratio, y: y - (y - value.y) * ratio };
    });
  };

  return <div className={`office-viewport${dragging ? " dragging" : ""}`} data-testid="agent-office" ref={viewportRef} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel}>
    <div className="office-controls" data-office-control>
      <button type="button" aria-label="放大办公室" onClick={() => { onViewportInteraction?.(); setCamera((value) => ({ ...value, zoom: clamp(value.zoom + 0.12, 0.28, 2) })); }}><Plus size={15} /></button>
      <button type="button" aria-label="缩小办公室" onClick={() => { onViewportInteraction?.(); setCamera((value) => ({ ...value, zoom: clamp(value.zoom - 0.12, 0.28, 2) })); }}><Minus size={15} /></button>
      <button type="button" aria-label="适应办公室" onClick={() => { onViewportInteraction?.(); cameraTouchedRef.current = false; fitToView(); }}><Maximize2 size={15} /></button>
    </div>
    <div className="office-canvas-host" ref={canvasHostRef} aria-hidden="true" />
    {rendererState !== "fallback" && loadingVisible ? <OfficeLoadingScreen progress={loadProgress} complete={loadProgress >= 100} /> : null}
    {rendererState === "fallback" ? <div className="office-fallback" role="group" aria-label="Agent 办公室列表">
      <div className="office-fallback-heading"><span>{rendererFailure?.userMessage ?? "办公场景暂时无法显示，请重试。"}</span><button type="button" onClick={() => setRetryVersion((value) => value + 1)}><RotateCcw size={14} />重试</button></div>
      <OfficeAgentList actors={scene.actors} selectedActorId={selectedActorId} onSelectActor={onSelectActor} />
    </div> : <div className="office-agent-overlay" style={{ width: scene.width, height: scene.height, transform: overlayTransform }}>
      {scene.actors.map((actor) => <button key={actor.actorId} type="button" className={`office-agent-hitbox ${actor.status}`} style={{ left: actor.anchors.seat.x - 68, top: actor.anchors.seat.y - 170 }} aria-label={`${actor.label}，${statusLabel(actor.status)}`} aria-pressed={selectedActorId === actor.actorId} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onSelectActor(actor.actorId, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }); }} data-office-actor={actor.actorId} data-testid={actor.kind === "main-agent" ? "agent-office-main-agent" : `agent-office-${actor.roleId}`}><span className="sr-only">{actor.label}</span></button>)}
    </div>}
  </div>;
}

function destroyOfficeApplication(app: Application | null): void {
  if (!app) return;
  try {
    app.destroy(false, { children: true });
  } catch {
    // A partially initialized Pixi application may not have every destroy system available.
  }
}

function OfficeAgentList({ actors, selectedActorId, onSelectActor }: { actors: OfficeActor[]; selectedActorId: string | null; onSelectActor: (actorId: string, anchor: { x: number; y: number }) => void }): ReactElement {
  return <div className="office-agent-list">{actors.map((actor) => <button key={actor.actorId} type="button" aria-pressed={selectedActorId === actor.actorId} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onSelectActor(actor.actorId, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }); }} data-testid={actor.kind === "main-agent" ? "agent-office-main-agent" : `agent-office-${actor.roleId}`}><span className={`office-agent-list-status ${actor.status}`} aria-hidden="true" /><strong>{actor.label}</strong><span>{statusLabel(actor.status)}</span></button>)}</div>;
}

async function createLoaderVisual(pixi: PixiModule, assets: OfficeRuntimeAssets, calibration: Readonly<OfficeCalibrationDocument>, reducedMotion: boolean): Promise<LoaderVisual> {
  const handle = await assets.acquireAction("walk-vertical", "main", "office-loader", "bootstrap");
  const frames = handle.asset.animationId ? handle.asset.sheet.animations[handle.asset.animationId] ?? [] : [];
  if (frames.length === 0) {
    handle.release();
    throw new Error("Office loader action has no frames.");
  }
  const container = new pixi.Container();
  container.position.set(calibration.world.width / 2, calibration.world.height / 2 - 20);
  const sprite = new pixi.AnimatedSprite(frames);
  applyOfficeActionVisual(sprite, handle.asset, "walk-vertical", calibration.actionVisualAlignments["walk-vertical"], false, reducedMotion, 0, true);
  container.addChild(sprite);
  return { container, handle };
}

export async function setOfficeStationScreen(assets: OfficeRuntimeAssets, station: StationVisual | undefined, profile: "off" | "static" | OfficeScreenProfile, signal: AbortSignal, phase = 0, reducedMotion = false): Promise<void> {
  if (!station) return;
  if (signal.aborted) return;
  if (profile === "off") { station.screen.visible = false; station.screen.stop(); return; }
  const requested: OfficeScreenProfile = profile === "static" ? "orchestration" : profile;
  const sameProfile = requested === station.screenProfile;
  const wasVisible = station.screen.visible;
  if (!sameProfile) {
    const handle = await assets.acquireScreen(requested, `station:${station.station.stationId}:screen`, requested === "orchestration" ? "semantic" : "ambient");
    if (signal.aborted) return handle.release();
    const frames = handle.asset.animationId ? handle.asset.sheet.animations[handle.asset.animationId] ?? [] : [];
    if (frames.length === 0) return handle.release();
    if (station.screenHandle !== handle) station.screenHandle.release();
    station.screenHandle = handle;
    station.screenProfile = requested;
    station.screen.textures = frames;
    station.screen.animationSpeed = OFFICE_SCREEN_ANIMATION_SPEED;
    station.screen.width = station.screenWidth;
    station.screen.height = station.screenHeight;
  }
  station.screen.visible = true;
  const frame = Math.min(station.screen.totalFrames - 1, Math.floor(phase * station.screen.totalFrames));
  if (reducedMotion || profile === "static") {
    station.screen.gotoAndStop(frame);
  } else if (!sameProfile || !wasVisible) {
    station.screen.gotoAndPlay(frame);
  } else if (!station.screen.playing) {
    station.screen.play();
  }
}

function setActorEffect(actorId: string, visual: OfficeActorVisual | undefined, world: OfficeStaticWorld, effect: string, reducedMotion: boolean): void {
  if (visual) visual.statusIndicator.visible = effect !== "none" && effect !== "coffee-cup";
  if (effect === "coffee-cup") {
    world.coffeeEffectOwner = actorId;
    world.coffeeEffect.visible = true;
    if (!reducedMotion) world.coffeeEffect.gotoAndPlay(0); else world.coffeeEffect.gotoAndStop(0);
  } else if (world.coffeeEffectOwner === actorId) {
    world.coffeeEffectOwner = null;
    world.coffeeEffect.visible = false;
    world.coffeeEffect.stop();
  }
}

function chooseResolution(host: HTMLElement): "1x" | "2x" { return host.clientWidth < 720 || (globalThis.devicePixelRatio || 1) < 1.5 ? "1x" : "2x"; }
function statusLabel(status: OfficeActorStatus): string { return ({ idle: "空闲", queued: "排队中", working: "正在工作", completed: "已完成", blocked: "需要修改", failed: "失败", attention: "需要你回答", interrupted: "已中断" } as const)[status]; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
