import type { AnimatedSprite, Container } from "pixi.js";
import type { OfficeAtlasHandle } from "./officeAssetLoader.js";
import type { OfficeCalibrationDocument } from "./officeCalibrationDocument.js";
import type { OfficeSceneModel, OfficeSceneStation } from "./officeScene.js";
import { OfficeSpriteFactory } from "./OfficeSpriteFactory.js";
import { OfficeRuntimeAssets, type OfficeScreenProfile, type ParsedOfficeAtlas } from "./officeRuntimeAssets.js";
import { OFFICE_SCREEN_ANIMATION_SPEED } from "./officeVisualContract.js";

type PixiModule = typeof import("pixi.js");

export type OfficeStationVisual = {
  station: OfficeSceneStation;
  screen: AnimatedSprite;
  screenHandle: OfficeAtlasHandle<ParsedOfficeAtlas>;
  screenProfile: OfficeScreenProfile;
  screenWidth: number;
  screenHeight: number;
};

export type OfficeStaticWorld = {
  root: Container;
  seatedActorLayer: Container;
  mobileActorLayer: Container;
  effectLayer: Container;
  stations: Map<string, OfficeStationVisual>;
  propsHandle: OfficeAtlasHandle<ParsedOfficeAtlas>;
  coffeeEffectHandle: OfficeAtlasHandle<ParsedOfficeAtlas>;
  coffeeEffect: AnimatedSprite;
  coffeeEffectOwner: string | null;
};

export class OfficeStaticSceneRenderer {
  constructor(
    private readonly pixi: PixiModule,
    private readonly assets: OfficeRuntimeAssets,
    private readonly calibration: Readonly<OfficeCalibrationDocument>,
  ) {}

  async build(scene: OfficeSceneModel, reducedMotion: boolean): Promise<OfficeStaticWorld> {
    const owner = "world:office-calibration-v5";
    const [propsHandle, coffeeEffectHandle] = await Promise.all([
      this.assets.acquireProps(owner),
      this.assets.acquireEffect("coffee-cup", `${owner}:coffee`),
    ]);
    try {
      const root = new this.pixi.Container();
      const layers = Object.fromEntries(this.calibration.layers.map((layer) => [layer, new this.pixi.Container()])) as Record<string, Container>;
      for (const layer of this.calibration.layers) root.addChild(layers[layer]!);
      const factory = new OfficeSpriteFactory(this.pixi, propsHandle.asset);
      this.drawFacilities(layers, factory);
      const stations = new Map<string, OfficeStationVisual>();
      for (const station of scene.stations) {
        const template = this.calibration.stationTemplates[station.workstationKind];
        if (!template) throw new Error(`Office station template ${station.workstationKind} is missing.`);
        const stationContainers = this.calibration.layers.reduce<Record<string, Container>>((result, layer) => {
          const container = new this.pixi.Container();
          container.position.set(station.origin.x, station.origin.y);
          layers[layer]!.addChild(container);
          result[layer] = container;
          return result;
        }, {});
        for (const component of template.components) factory.add(stationContainers[component.layer]!, component);
        const screenHandle = await this.assets.acquireScreen("orchestration", `station:${station.stationId}:screen`);
        const screen = this.createScreen(screenHandle.asset, template.screenSlot, reducedMotion);
        stationContainers[template.screenSlot.layer]!.addChild(screen.mask as Container, screen);
        screen.visible = false;
        stations.set(station.stationId, {
          station,
          screen,
          screenHandle,
          screenProfile: "orchestration",
          screenWidth: template.screenSlot.width,
          screenHeight: template.screenSlot.height,
        });
      }
      const coffeeEffect = this.createCoffeeEffect(coffeeEffectHandle.asset, reducedMotion);
      layers.effect!.addChild(coffeeEffect);
      return {
        root,
        seatedActorLayer: layers["actor-seated"]!,
        mobileActorLayer: layers["actor-mobile"]!,
        effectLayer: layers.effect!,
        stations,
        propsHandle,
        coffeeEffectHandle,
        coffeeEffect,
        coffeeEffectOwner: null,
      };
    } catch (error) {
      propsHandle.release();
      coffeeEffectHandle.release();
      throw error;
    }
  }

  private drawFacilities(layers: Record<string, Container>, factory: OfficeSpriteFactory): void {
    for (const facility of Object.values(this.calibration.facilities)) {
      for (const component of facility.components) {
        const parent = new this.pixi.Container();
        parent.position.set(facility.origin.x, facility.origin.y);
        layers[component.layer]!.addChild(parent);
        factory.add(parent, component);
      }
    }
  }

  private createScreen(atlas: ParsedOfficeAtlas, slot: OfficeCalibrationDocument["stationTemplates"][string]["screenSlot"], reducedMotion: boolean): AnimatedSprite {
    const frames = atlas.animationId ? atlas.sheet.animations[atlas.animationId] ?? [] : [];
    if (frames.length === 0) throw new Error("Office orchestration screen has no frames.");
    const screen = new this.pixi.AnimatedSprite(frames);
    screen.anchor.set(0.5);
    screen.position.set(slot.localPosition.x, slot.localPosition.y);
    screen.width = slot.width;
    screen.height = slot.height;
    screen.animationSpeed = OFFICE_SCREEN_ANIMATION_SPEED;
    screen.loop = true;
    screen.visible = slot.visible;
    const mask = new this.pixi.Graphics()
      .roundRect(slot.localPosition.x - slot.width / 2, slot.localPosition.y - slot.height / 2, slot.width, slot.height, 2)
      .fill(0xffffff);
    mask.visible = slot.visible;
    screen.mask = mask;
    if (reducedMotion) screen.gotoAndStop(0); else screen.play();
    return screen;
  }

  private createCoffeeEffect(atlas: ParsedOfficeAtlas, reducedMotion: boolean): AnimatedSprite {
    const frames = atlas.animationId ? atlas.sheet.animations[atlas.animationId] ?? [] : [];
    const effect = new this.pixi.AnimatedSprite(frames);
    const coffee = this.calibration.facilities.coffee;
    if (!coffee?.effectSlot) throw new Error("Office coffee effect slot is missing.");
    effect.position.set(
      coffee.origin.x + coffee.effectSlot.localPosition.x,
      coffee.origin.y + coffee.effectSlot.localPosition.y,
    );
    effect.scale.set(coffee.effectSlot.scale.x, coffee.effectSlot.scale.y);
    effect.animationSpeed = Math.max(0.03, atlas.animation.fps / 60);
    effect.loop = true;
    effect.visible = false;
    if (reducedMotion) effect.gotoAndStop(0);
    return effect;
  }
}

export function destroyOfficeStaticWorld(world: OfficeStaticWorld | null): void {
  if (!world) return;
  const handles = new Set([
    world.propsHandle,
    world.coffeeEffectHandle,
    ...[...world.stations.values()].map((station) => station.screenHandle),
  ]);
  for (const handle of handles) handle.release();
  world.root.destroy({ children: true });
}
