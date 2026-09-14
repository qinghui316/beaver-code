#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOfficeCalibrationJson,
  parseOfficeHandoffMirrorOverridesV1,
  promoteOfficeCalibrationV4,
  type OfficeCalibrationDocument,
  type OfficeCalibrationPoint,
} from "../src/web/src/office/officeCalibrationDocument.js";
import {
  OFFICE_ACTION_FRAME_COUNTS,
  officeActionPlaybackRate,
  officeFacilityRoutePoints,
  officeFacilityStageFlipX,
  officeFacilityStageOffset,
  officeFacilityStagePointOffsets,
  officeHandoffInteractionWorldPoint,
  officeHandoffLinkedWalkBasePoint,
  officeHandoffRoutePoints,
  officeHandoffSaluteWorldPoint,
  officeHandoffSeatedTalkWorldPoint,
  officeHandoffStageOffset,
  officeHandoffStagePathPointOffsets,
  officeHandoffWalkVerticalFlipX,
  officeHandoffWalkVerticalReturnFlipX,
  officeSeatActorAnchor,
  type OfficeActionId,
  type OfficeFacilityRoute,
  type OfficeHandoffMovingStageId,
  type OfficeMovingRouteStageId,
  type OfficePoint,
  type OfficeRouteStageId,
  type OfficeSceneGeometryCalibration,
} from "./office-calibration-v3.js";

const DEFAULT_DOCUMENT = "src/web/public/agent-office/config/office-calibration.json";
const DEFAULT_ATLAS = "src/web/public/agent-office/props/office-props@1x.webp.json";
const DEFAULT_HIGH_RES_ATLAS = "src/web/public/agent-office/props/office-props@2x.webp.json";
const DEFAULT_SHADOW_PROOF = "design-assets/agent-office/approved/shadows/baked-shadow-calibration.json";

type JsonRecord = Record<string, unknown>;
type AtlasFrame = { spriteSourceSize: { x: number; y: number } };

export async function migrateOfficeCalibrationFile(
  sourcePath: string,
  targetPath = DEFAULT_DOCUMENT,
  atlasPath = DEFAULT_ATLAS,
  shadowProofPath = DEFAULT_SHADOW_PROOF,
  highResolutionAtlasPath = DEFAULT_HIGH_RES_ATLAS,
): Promise<{ targetPath: string; backupPath: string | null; sha256: string }> {
  const [legacySource, atlasSource, shadowProofSource, highResolutionAtlasSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(atlasPath, "utf8"),
    readFile(shadowProofPath, "utf8"),
    readFile(highResolutionAtlasPath, "utf8"),
  ]);
  const legacy = parseJsonRecord(legacySource, "Legacy Office calibration");
  const atlas = parseJsonRecord(atlasSource, "Office props atlas");
  const shadowProof = parseJsonRecord(shadowProofSource, "Approved shadow proof");
  const highResolutionAtlas = parseJsonRecord(highResolutionAtlasSource, "High-resolution Office props atlas");
  const document = migrateOfficeCalibrationV3(legacy, atlas, shadowProof, highResolutionAtlas);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const absoluteTarget = resolve(targetPath);
  const backupPath = await atomicReplaceWithBackup(absoluteTarget, serialized);
  return { targetPath: absoluteTarget, backupPath, sha256: sha256(serialized) };
}

export function migrateOfficeCalibrationV3(legacy: unknown, atlas: unknown, shadowProof: unknown, highResolutionAtlas: unknown): Readonly<OfficeCalibrationDocument> {
  const source = asRecord(legacy, "Legacy Office calibration");
  if (source.schemaVersion !== 3) throw new Error("Legacy Office calibration schemaVersion must be 3.");
  const atlasRoot = asRecord(atlas, "Office props atlas");
  const atlasFrames = asRecord(atlasRoot.frames, "Office props atlas frames");
  const roster = asRecord(source.roster, "Legacy roster");
  const workstations = asRecord(source.workstations, "Legacy workstations");
  const facilities = asRecord(source.facilities, "Legacy facilities");
  const actionScales = asRecord(source.actionScales, "Legacy action scales");
  const actionOffsets = asRecord(source.actionOffsets, "Legacy action offsets");
  const canonicalShadowPositions = deriveCanonicalShadowPositions(source, shadowProof, highResolutionAtlas);

  const stationTemplates = Object.fromEntries(["standard", "main"].map((templateId) => {
    const workstation = asRecord(workstations[templateId], `Legacy workstation ${templateId}`);
    const deskId = stringValue(workstation.deskId, `${templateId} deskId`);
    const chairId = stringValue(workstation.chairId, `${templateId} chairId`);
    const shadow = asRecord(workstation.shadow, `${templateId} shadow`);
    return [templateId, {
      components: [
        staticComponent("shadow", stringValue(shadow.resourceId, `${templateId} shadow resourceId`), shadow, canonicalShadowPositions[templateId as "standard" | "main"]),
        migratedStationComponent("desk", deskId, workstation.desk, atlasFrames),
        migratedStationComponent("monitor", "standard-monitor", workstation.monitor, atlasFrames),
        migratedStationComponent("chair", chairId, workstation.chair, atlasFrames),
      ],
      screenSlot: positionedDimensions(workstation.screen, `${templateId} screen`),
      actorAnchor: positionedSlot(workstation.actor, `${templateId} actor`),
      label: positionedLabel(workstation.label, `${templateId} label`),
      anchors: cloneJson(asRecord(workstation.anchors, `${templateId} anchors`)),
    }];
  }));

  const coffee = asRecord(facilities.coffee, "Legacy coffee facility");
  const treadmill = asRecord(facilities.treadmill, "Legacy treadmill facility");
  const toilet = asRecord(facilities.toilet, "Legacy toilet facility");
  const toiletPaper = asRecord(facilities.toiletPaper, "Legacy toilet paper facility");
  const toiletTail = asRecord(facilities.toiletTailOccluder, "Legacy toilet tail facility");
  const coffeeCup = asRecord(facilities.coffeeCup, "Legacy coffee cup facility");

  const document = {
    schemaVersion: 4,
    world: cloneJson(asRecord(source.world, "Legacy world")),
    layers: cloneJson(arrayValue(source.layerOrder, "Legacy layer order")),
    actionVisualAlignments: Object.fromEntries(Object.keys(actionScales).map((actionId) => [actionId, {
      scale: numberValue(actionScales[actionId], `Legacy action scale ${actionId}`),
      offset: clonePoint(actionOffsets[actionId], `Legacy action offset ${actionId}`),
    }])),
    transitionDirections: cloneJson(asRecord(source.transitionDirections, "Legacy transition directions")),
    stations: {
      columnStep: numberValue(roster.columnStep, "Legacy station column step"),
      items: arrayValue(roster.seats, "Legacy roster seats").map((entry, index) => {
        const seat = asRecord(entry, `Legacy station ${index}`);
        return {
          stationId: stringValue(seat.slotId, `Legacy station ${index} slotId`),
          label: stringValue(seat.label, `Legacy station ${index} label`),
          preferredRoleId: stringValue(seat.roleId, `Legacy station ${index} roleId`),
          stationTemplateId: stringValue(seat.workstationKind, `Legacy station ${index} workstationKind`),
          origin: clonePoint(seat.origin, `Legacy station ${index} origin`),
          actorOffset: clonePoint(seat.actorOffset, `Legacy station ${index} actorOffset`),
          visible: booleanValue(seat.visible, `Legacy station ${index} visible`),
        };
      }),
    },
    stationTemplates,
    facilities: {
      coffee: migrateFacility(coffee, [
        facilityBodyComponent(coffee),
        facilityShadowComponent(coffee, canonicalShadowPositions.coffee),
      ], {
        resourceId: stringValue(coffeeCup.propId, "Legacy coffee cup propId"),
        localPosition: subtractPoints(coffeeCup.origin, coffee.origin, "Legacy coffee cup local position"),
        scale: uniformScale(coffeeCup.scale, "Legacy coffee cup scale"),
        layer: stringValue(coffeeCup.layer, "Legacy coffee cup layer"),
        visible: booleanValue(coffeeCup.visible, "Legacy coffee cup visible"),
      }),
      treadmill: migrateFacility(treadmill, [
        facilityBodyComponent(treadmill),
        facilityShadowComponent(treadmill, canonicalShadowPositions.treadmill),
      ]),
      toilet: migrateFacility(toilet, [
        facilityBodyComponent(toilet),
        facilityBodyComponent(toiletPaper, "toilet-paper", subtractPoints(toiletPaper.origin, toilet.origin, "Legacy toilet paper local position")),
        facilityBodyComponent(toiletTail, "tail-occluder", subtractPoints(toiletTail.origin, toilet.origin, "Legacy toilet tail local position")),
      ]),
    },
    routes: resolveLegacyFacilityRoutes(source as unknown as OfficeSceneGeometryCalibration),
    handoffs: resolveLegacyHandoffs(source as unknown as OfficeSceneGeometryCalibration),
  };
  return promoteOfficeCalibrationV4(document);
}

export async function promoteOfficeHandoffCalibrationFiles(
  sourceV4Path: string,
  mirrorPatchPath: string,
  targetV5Path: string,
): Promise<{ targetPath: string; backupPath: string | null; sourceV4Sha256: string; mirrorPatchSha256: string; sha256: string }> {
  const [v4Source, mirrorPatchSource] = await Promise.all([
    readFile(sourceV4Path, "utf8"),
    readFile(mirrorPatchPath, "utf8"),
  ]);
  const v4 = parseJsonRecord(v4Source, "Office calibration V4");
  const patch = parseOfficeHandoffMirrorOverridesV1(parseJsonRecord(mirrorPatchSource, "Office handoff mirror overrides"));
  const sourceV4Sha256 = sha256(v4Source);
  if (patch.v4Sha256 !== sourceV4Sha256) {
    throw new Error("Office handoff mirror overrides do not match the supplied V4 bytes.");
  }
  const document = promoteOfficeCalibrationV4(v4, patch);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const absoluteTarget = resolve(targetV5Path);
  const backupPath = await atomicReplaceWithBackup(absoluteTarget, serialized);
  return {
    targetPath: absoluteTarget,
    backupPath,
    sourceV4Sha256,
    mirrorPatchSha256: sha256(mirrorPatchSource),
    sha256: sha256(serialized),
  };
}

function deriveCanonicalShadowPositions(
  legacy: JsonRecord,
  shadowProof: unknown,
  highResolutionAtlas: unknown,
): Record<"standard" | "main" | "coffee" | "treadmill", OfficeCalibrationPoint> {
  const proof = asRecord(shadowProof, "Approved shadow proof");
  const entries = arrayValue(proof.shadows, "Approved shadow proof shadows").map((value, index) => asRecord(value, `Approved shadow proof entry ${index}`));
  const proofPosition = (target: string, parent: "workstation" | "facility"): OfficeCalibrationPoint => {
    const entry = entries.find((candidate) => candidate.target === target && candidate.parent === parent);
    if (!entry) throw new Error(`Approved shadow proof is missing ${parent} ${target}.`);
    const crop = asRecord(entry.sourceCrop, `Approved shadow proof ${target} sourceCrop`);
    const proofConfig = asRecord(entry.proof, `Approved shadow proof ${target} proof`);
    const shift = asRecord(proofConfig.shift, `Approved shadow proof ${target} shift`);
    const parentOrigin = asRecord(entry.parentOrigin, `Approved shadow proof ${target} parentOrigin`);
    const outputScale = numberValue(proofConfig.outputScale, `Approved shadow proof ${target} outputScale`);
    if (outputScale <= 0) throw new Error(`Approved shadow proof ${target} outputScale must be positive.`);
    return {
      x: (numberValue(crop.left, `${target} crop left`) - numberValue(shift.x, `${target} shift x`)) / outputScale - numberValue(parentOrigin.x, `${target} parent origin x`),
      y: (numberValue(crop.top, `${target} crop top`) - numberValue(shift.y, `${target} shift y`)) / outputScale - numberValue(parentOrigin.y, `${target} parent origin y`),
    };
  };
  const facilities = asRecord(legacy.facilities, "Legacy facilities");
  const facilityPosition = (target: "coffee" | "treadmill"): OfficeCalibrationPoint => {
    const base = proofPosition(target, "facility");
    const padding = facilityBodyAtlasPadding(asRecord(facilities[target], `Legacy ${target} facility`), highResolutionAtlas);
    return { x: base.x + padding.x, y: base.y + padding.y };
  };
  return {
    standard: proofPosition("standard", "workstation"),
    main: proofPosition("main", "workstation"),
    coffee: facilityPosition("coffee"),
    treadmill: facilityPosition("treadmill"),
  };
}

function facilityBodyAtlasPadding(facility: JsonRecord, atlas: unknown): OfficeCalibrationPoint {
  const atlasRoot = asRecord(atlas, "High-resolution Office props atlas");
  const metadata = asRecord(atlasRoot.meta, "High-resolution Office props atlas meta");
  const resolution = numberValue(metadata.scale, "High-resolution Office props atlas scale");
  if (resolution <= 0) throw new Error("High-resolution Office props atlas scale must be positive.");
  const resourceId = stringValue(facility.propId, "Legacy facility propId");
  const props = asRecord(metadata.officeProps, "High-resolution Office props atlas metadata");
  const prop = asRecord(props[resourceId], `High-resolution Office prop ${resourceId}`);
  const frameId = stringValue(prop.frame, `High-resolution Office prop ${resourceId} frame`);
  const frames = asRecord(atlasRoot.frames, "High-resolution Office props atlas frames");
  const frame = asRecord(frames[frameId], `High-resolution Office props atlas frame ${frameId}`);
  const trim = asRecord(frame.spriteSourceSize, `High-resolution Office props atlas trim ${frameId}`);
  const scale = numberValue(facility.scale, `Legacy facility ${resourceId} scale`);
  return {
    x: numberValue(trim.x, `${resourceId} trim x`) / resolution * scale,
    y: numberValue(trim.y, `${resourceId} trim y`) / resolution * scale,
  };
}

type ResolvedStage = {
  id: string;
  actionId: OfficeActionId;
  points: OfficePoint[];
  durationMs: number;
  flipX: boolean;
  reverse?: boolean;
};

function resolveLegacyFacilityRoutes(calibration: OfficeSceneGeometryCalibration): Record<string, Record<OfficeFacilityRoute, ResolvedStage[]>> {
  return Object.fromEntries(calibration.roster.seats.map((station, index) => [station.slotId, Object.fromEntries(
    (["coffee", "treadmill", "toilet"] as const).map((route) => [route, resolveLegacyFacilityRoute(route, index, calibration)]),
  )])) as Record<string, Record<OfficeFacilityRoute, ResolvedStage[]>>;
}

function resolveLegacyFacilityRoute(route: OfficeFacilityRoute, stationIndex: number, calibration: OfficeSceneGeometryCalibration): ResolvedStage[] {
  const seat = officeSeatActorAnchor(stationIndex, calibration);
  const base = officeFacilityRoutePoints(route, stationIndex, calibration);
  const stage = (id: string, actionId: OfficeActionId, points: OfficePoint[], flipX: boolean, reverse = false): ResolvedStage => ({
    id,
    actionId,
    points: resolveLegacyFacilityPoints(route, id, points, stationIndex, calibration),
    durationMs: route === "coffee" && id === "facility-use" ? 25 / 24 * 1_000 : actionDurationMs(actionId),
    flipX: officeFacilityStageFlipX(route, id as OfficeRouteStageId, stationIndex, flipX, calibration),
    reverse,
  });
  const offChairOut = stage("off-chair-out", "off-chair", [seat], false);
  const leavingOut = stage("leaving-out", "leaving", [seat, midpoint(seat, base.start), base.start], facesRight(seat, base.start));
  const walkOut = stage("walk-out", "walk-horizontal", [base.start, base.waypoint, base.contact], facesRight(base.start, base.contact));
  const facilityUse = stage("facility-use", route === "coffee" ? "leaving" : route, [base.contact], false);
  const outbound = [offChairOut, leavingOut, walkOut, facilityUse];
  if (route === "treadmill") outbound.push(stage("facility-reverse", "treadmill", [base.contact], false, true));
  const reversedStage = (id: "walk-return" | "leaving-return", source: ResolvedStage): ResolvedStage => ({
    id,
    actionId: source.actionId,
    points: [...source.points].reverse(),
    durationMs: source.durationMs,
    flipX: officeFacilityStageFlipX(route, id, stationIndex, !source.flipX, calibration),
  });
  return [
    ...outbound,
    reversedStage("walk-return", walkOut),
    reversedStage("leaving-return", leavingOut),
    stage("off-chair-return", "off-chair", [seat], false, true),
  ];
}

function resolveLegacyFacilityPoints(
  route: OfficeFacilityRoute,
  stageId: string,
  points: OfficePoint[],
  stationIndex: number,
  calibration: OfficeSceneGeometryCalibration,
): OfficePoint[] {
  const stageOffset = officeFacilityStageOffset(route, stageId as OfficeRouteStageId, stationIndex, calibration);
  const pointOffsets = stageId in calibration.routeStagePointOffsets[route]
    ? officeFacilityStagePointOffsets(route, stageId as OfficeMovingRouteStageId, stationIndex, calibration)
    : null;
  return points.map((point, index) => addPoints(
    point,
    stageOffset,
    pointOffsets ? index === 0 ? pointOffsets.start : index === points.length - 1 ? pointOffsets.end : pointOffsets.waypoint : { x: 0, y: 0 },
  ));
}

function resolveLegacyHandoffs(calibration: OfficeSceneGeometryCalibration): Record<string, Record<string, ReturnType<typeof resolveLegacyHandoff>>> {
  return Object.fromEntries(calibration.roster.seats.map((source, sourceIndex) => [source.slotId, Object.fromEntries(
    calibration.roster.seats
      .map((target, targetIndex) => ({ target, targetIndex }))
      .filter(({ targetIndex }) => targetIndex !== sourceIndex)
      .map(({ target, targetIndex }) => [target.slotId, resolveLegacyHandoff(sourceIndex, targetIndex, calibration)]),
  )]));
}

function resolveLegacyHandoff(sourceIndex: number, targetIndex: number, calibration: OfficeSceneGeometryCalibration) {
  const sourceStationId = calibration.roster.seats[sourceIndex]!.slotId;
  const targetStationId = calibration.roster.seats[targetIndex]!.slotId;
  const points = officeHandoffRoutePoints(sourceIndex, targetIndex, calibration);
  const approachEnd = officeHandoffLinkedWalkBasePoint("walk-target-approach", "end", sourceIndex, targetIndex, calibration);
  const outboundBase: Array<{ id: OfficeHandoffMovingStageId; actionId: OfficeActionId; from: OfficePoint; to: OfficePoint; flipX: boolean }> = [
    { id: "source-leaving-out", actionId: "leaving", from: points.sourceSeat, to: points.sourceAisle, flipX: facesRight(points.sourceSeat, points.sourceAisle) },
    { id: "walk-source-corridor", actionId: "walk-horizontal", from: points.sourceAisle, to: points.sourceCorridor, flipX: facesRight(points.sourceAisle, points.sourceCorridor) },
    { id: "walk-target-row", actionId: "walk-vertical", from: points.sourceCorridor, to: points.targetCorridor, flipX: officeHandoffWalkVerticalFlipX(targetIndex, calibration) },
    { id: "walk-target-approach", actionId: "walk-horizontal", from: points.targetCorridor, to: approachEnd, flipX: facesRight(points.targetCorridor, approachEnd) },
  ];
  const outbound = outboundBase.map((item) => {
    const stageOffset = officeHandoffStageOffset(item.id, targetIndex, calibration);
    const pointOffsets = officeHandoffStagePathPointOffsets(item.id, targetIndex, calibration);
    const via = midpoint(item.from, item.to);
    return {
      id: item.id,
      actionId: item.actionId,
      points: [
        addPoints(item.from, stageOffset, pointOffsets.start),
        addPoints(via, stageOffset, pointOffsets.waypoint),
        addPoints(item.to, stageOffset, pointOffsets.end),
      ],
      durationMs: actionDurationMs(item.actionId),
      flipX: item.flipX,
    } satisfies ResolvedStage;
  });
  const reversedIds: OfficeHandoffMovingStageId[] = ["walk-target-depart", "walk-source-row", "walk-source-approach", "source-leaving-return"];
  const returned = [...outbound].reverse().map((item, index) => ({
    ...item,
    id: reversedIds[index]!,
    points: [...item.points].reverse(),
    flipX: item.actionId === "walk-vertical"
      ? officeHandoffWalkVerticalReturnFlipX(targetIndex, calibration)
      : facesRight(item.points.at(-1)!, item.points[0]!),
    reverse: false,
  }));
  return {
    sourceStationId,
    targetStationId,
    outbound,
    standingTalk: subtractPoint(
      officeHandoffInteractionWorldPoint(sourceIndex, targetIndex, calibration),
      calibration.actionOffsets["standing-talk"],
    ),
    seatedTalk: subtractPoint(officeHandoffSeatedTalkWorldPoint(targetIndex, calibration), calibration.actionOffsets["seated-talk"]),
    salute: subtractPoint(officeHandoffSaluteWorldPoint(targetIndex, calibration), calibration.actionOffsets.salute),
    return: returned,
  };
}

function actionDurationMs(actionId: OfficeActionId): number {
  const fps: Record<OfficeActionId, number> = {
    working: 12, standby: 20, "coffee-drink": 12, peek: 12, "off-chair": 12,
    "walk-horizontal": 16, "walk-vertical": 12, leaving: 12, treadmill: 16,
    toilet: 24, "standing-talk": 24, "seated-talk": 24, salute: 24,
  };
  return Math.round(OFFICE_ACTION_FRAME_COUNTS[actionId] / (fps[actionId] * officeActionPlaybackRate(actionId)) * 1_000);
}

function addPoints(...points: OfficePoint[]): OfficePoint {
  return points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
}

function subtractPoint(left: OfficePoint, right: OfficePoint): OfficePoint {
  return { x: left.x - right.x, y: left.y - right.y };
}

function midpoint(left: OfficePoint, right: OfficePoint): OfficePoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function facesRight(from: OfficePoint, to: OfficePoint): boolean {
  return to.x >= from.x;
}

export async function validateOfficeCalibrationFile(path = DEFAULT_DOCUMENT): Promise<{ path: string; sha256: string }> {
  const source = await readFile(path, "utf8");
  parseOfficeCalibrationJson(source);
  return { path: resolve(path), sha256: sha256(source) };
}

export async function diffOfficeCalibrationFiles(leftPath: string, rightPath: string): Promise<readonly string[]> {
  const [leftSource, rightSource] = await Promise.all([readFile(leftPath, "utf8"), readFile(rightPath, "utf8")]);
  const left = parseOfficeCalibrationJson(leftSource);
  const right = parseOfficeCalibrationJson(rightSource);
  return diffValues(left, right);
}

function migratedStationComponent(componentId: string, resourceId: string, value: unknown, atlasFrames: JsonRecord): JsonRecord {
  const transform = asRecord(value, `Legacy station component ${componentId}`);
  const frame = asRecord(atlasFrames[`${resourceId}.png`], `Atlas frame ${resourceId}.png`) as JsonRecord;
  const trim = asRecord(frame.spriteSourceSize, `Atlas trim ${resourceId}.png`) as unknown as AtlasFrame["spriteSourceSize"];
  const scaleX = numberValue(transform.scaleX, `${componentId} scaleX`);
  const scaleY = numberValue(transform.scaleY, `${componentId} scaleY`);
  return staticComponent(componentId, resourceId, transform, {
    x: numberValue(transform.x, `${componentId} x`) - numberValue(trim.x, `${componentId} trim x`) * scaleX,
    y: numberValue(transform.y, `${componentId} y`) - numberValue(trim.y, `${componentId} trim y`) * scaleY,
  });
}

function staticComponent(componentId: string, resourceId: string, value: JsonRecord, localPosition: OfficeCalibrationPoint): JsonRecord {
  return {
    componentId,
    resourceId,
    localPosition,
    scale: {
      x: numberValue(value.scaleX, `${componentId} scaleX`),
      y: numberValue(value.scaleY, `${componentId} scaleY`),
    },
    alpha: value.alpha == null ? 1 : numberValue(value.alpha, `${componentId} alpha`),
    layer: stringValue(value.layer, `${componentId} layer`),
    visible: booleanValue(value.visible, `${componentId} visible`),
  };
}

function facilityBodyComponent(facility: JsonRecord, componentId = "body", localPosition: OfficeCalibrationPoint = { x: 0, y: 0 }): JsonRecord {
  const resourceId = stringValue(facility.propId, `Legacy facility ${componentId} propId`);
  const scale = uniformScale(facility.scale, `Legacy facility ${componentId} scale`);
  return {
    componentId,
    resourceId,
    localPosition,
    scale,
    alpha: 1,
    layer: stringValue(facility.layer, `Legacy facility ${componentId} layer`),
    visible: booleanValue(facility.visible, `Legacy facility ${componentId} visible`),
  };
}

function facilityShadowComponent(facility: JsonRecord, localPosition: OfficeCalibrationPoint): JsonRecord {
  return staticComponent("shadow", stringValue(asRecord(facility.shadow, "Legacy facility shadow").resourceId, "Legacy facility shadow resourceId"), asRecord(facility.shadow, "Legacy facility shadow"), localPosition);
}

function migrateFacility(facility: JsonRecord, components: JsonRecord[], effectSlot?: JsonRecord): JsonRecord {
  const origin = clonePoint(facility.origin, "Legacy facility origin");
  const anchors = asRecord(facility.anchors, "Legacy facility anchors");
  return {
    origin,
    components,
    anchors: Object.fromEntries(Object.entries(anchors).map(([id, point]) => [id, subtractPoints(point, origin, `Legacy facility anchor ${id}`)])),
    ...(effectSlot ? { effectSlot } : {}),
  };
}

function positionedSlot(value: unknown, label: string): JsonRecord {
  const slot = asRecord(value, label);
  return {
    localPosition: { x: numberValue(slot.x, `${label} x`), y: numberValue(slot.y, `${label} y`) },
    layer: stringValue(slot.layer, `${label} layer`),
    visible: booleanValue(slot.visible, `${label} visible`),
  };
}

function positionedDimensions(value: unknown, label: string): JsonRecord {
  const slot = asRecord(value, label);
  return {
    ...positionedSlot(slot, label),
    width: numberValue(slot.width, `${label} width`),
    height: numberValue(slot.height, `${label} height`),
  };
}

function positionedLabel(value: unknown, label: string): JsonRecord {
  const slot = asRecord(value, label);
  return { ...positionedSlot(slot, label), scale: numberValue(slot.scale, `${label} scale`) };
}

function uniformScale(value: unknown, label: string): { x: number; y: number } {
  const scale = numberValue(value, label);
  return { x: scale, y: scale };
}

function subtractPoints(value: unknown, parent: unknown, label: string): OfficeCalibrationPoint {
  const point = clonePoint(value, label);
  const origin = clonePoint(parent, `${label} parent`);
  return { x: point.x - origin.x, y: point.y - origin.y };
}

function clonePoint(value: unknown, label: string): OfficeCalibrationPoint {
  const point = asRecord(value, label);
  return { x: numberValue(point.x, `${label} x`), y: numberValue(point.y, `${label} y`) };
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function parseJsonRecord(source: string, label: string): JsonRecord {
  try {
    return asRecord(JSON.parse(source), label);
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

async function atomicReplaceWithBackup(target: string, source: string): Promise<string | null> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${target}.bak`;
  await writeFile(temporary, source, "utf8");
  let movedOriginal = false;
  try {
    try {
      await rm(backup, { force: true });
      await rename(target, backup);
      movedOriginal = true;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await rename(temporary, target);
    return movedOriginal ? backup : null;
  } catch (error) {
    await rm(temporary, { force: true });
    if (movedOriginal) {
      await rm(target, { force: true });
      await rename(backup, target);
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function diffValues(left: unknown, right: unknown, path = "$", changes: string[] = []): readonly string[] {
  if (Object.is(left, right)) return changes;
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) diffValues(left[index], right[index], `${path}[${index}]`, changes);
    return changes;
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) diffValues(left[key], right[key], `${path}.${key}`, changes);
    return changes;
  }
  changes.push(`${path}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`);
  return changes;
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "migrate") {
    if (!args[0]) throw new Error("Usage: office-calibration migrate <v3-source.json> [v4-target.json] [props-atlas@1x.json] [shadow-proof.json] [props-atlas@2x.json]");
    console.log(JSON.stringify(await migrateOfficeCalibrationFile(
      args[0],
      args[1] ?? DEFAULT_DOCUMENT,
      args[2] ?? DEFAULT_ATLAS,
      args[3] ?? DEFAULT_SHADOW_PROOF,
      args[4] ?? DEFAULT_HIGH_RES_ATLAS,
    ), null, 2));
    return;
  }
  if (command === "validate") {
    console.log(JSON.stringify(await validateOfficeCalibrationFile(args[0] ?? DEFAULT_DOCUMENT), null, 2));
    return;
  }
  if (command === "promote-handoff") {
    const outputFlag = args.indexOf("--out");
    const target = outputFlag >= 0 ? args[outputFlag + 1] : undefined;
    if (!args[0] || !args[1] || !target || outputFlag !== 2 || args.length !== 4) {
      throw new Error("Usage: office-calibration promote-handoff <v4.json> <mirror-overrides-v1.json> --out <v5.json>");
    }
    console.log(JSON.stringify(await promoteOfficeHandoffCalibrationFiles(args[0], args[1], target), null, 2));
    return;
  }
  if (command === "diff") {
    if (!args[0] || !args[1]) throw new Error("Usage: office-calibration diff <left-v4.json> <right-v4.json>");
    const changes = await diffOfficeCalibrationFiles(args[0], args[1]);
    console.log(changes.length === 0 ? "No calibration differences." : changes.join("\n"));
    return;
  }
  throw new Error("Usage: office-calibration <migrate|promote-handoff|validate|diff> [...args]");
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
