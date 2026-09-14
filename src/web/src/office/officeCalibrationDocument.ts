import { z } from "zod";
import type { OfficeActionId, OfficeHandoffActionInstanceId } from "./officeVisualContract.js";

export const OFFICE_CALIBRATION_SCHEMA_VERSION = 5 as const;
export const OFFICE_CALIBRATION_LAYERS = ["shadow", "desk", "screen", "actor-seated", "chair", "actor-mobile", "effect"] as const;
export const OFFICE_CALIBRATION_ACTION_IDS = [
  "working", "standby", "coffee-drink", "peek", "off-chair", "walk-horizontal", "walk-vertical",
  "leaving", "treadmill", "toilet", "standing-talk", "seated-talk", "salute",
] as const;
export const OFFICE_CALIBRATION_FACILITY_IDS = ["coffee", "treadmill", "toilet"] as const;
export const OFFICE_HANDOFF_OUTBOUND_STAGE_IDS = [
  "source-leaving-out", "walk-source-corridor", "walk-target-row", "walk-target-approach",
] as const;
export const OFFICE_HANDOFF_RETURN_STAGE_IDS = [
  "walk-target-depart", "walk-source-row", "walk-source-approach", "source-leaving-return",
] as const;
export const OFFICE_HANDOFF_ACTION_INSTANCE_IDS = [
  "depart:off-chair",
  ...OFFICE_HANDOFF_OUTBOUND_STAGE_IDS.map((id) => `outbound:${id}` as const),
  "interaction:standing-talk",
  "interaction:seated-talk",
  "interaction:salute",
  ...OFFICE_HANDOFF_RETURN_STAGE_IDS.map((id) => `return:${id}` as const),
  "finish:off-chair",
] as const satisfies readonly OfficeHandoffActionInstanceId[];

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const scaleSchema = z.object({ x: z.number().finite().positive(), y: z.number().finite().positive() }).strict();
const layerSchema = z.enum(OFFICE_CALIBRATION_LAYERS);
const positionedSlotSchema = z.object({
  localPosition: pointSchema,
  layer: layerSchema,
  visible: z.boolean(),
}).strict();
const staticComponentSchema = positionedSlotSchema.extend({
  componentId: z.string().min(1),
  resourceId: z.string().min(1),
  scale: scaleSchema,
  alpha: z.number().finite().min(0).max(1),
}).strict();
const screenSlotSchema = positionedSlotSchema.extend({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();
const labelSchema = positionedSlotSchema.extend({ scale: z.number().finite().positive() }).strict();
const actionVisualAlignmentSchema = z.object({
  scale: z.number().finite().positive(),
  offset: pointSchema,
}).strict();
const transitionDirectionSchema = z.object({
  fromFlipX: z.boolean(),
  toFlipX: z.boolean(),
  fromReverse: z.boolean(),
  toReverse: z.boolean(),
}).strict();
const stationSchema = z.object({
  stationId: z.string().min(1),
  label: z.string().min(1),
  preferredRoleId: z.string().min(1),
  stationTemplateId: z.string().min(1),
  origin: pointSchema,
  actorOffset: pointSchema,
  visible: z.boolean(),
}).strict();
const stationTemplateSchema = z.object({
  components: z.array(staticComponentSchema).min(1),
  screenSlot: screenSlotSchema,
  actorAnchor: positionedSlotSchema,
  label: labelSchema,
  anchors: z.record(z.string().min(1), pointSchema),
}).strict();
const effectSlotSchema = positionedSlotSchema.extend({
  resourceId: z.string().min(1),
  scale: scaleSchema,
}).strict();
const facilitySchema = z.object({
  origin: pointSchema,
  components: z.array(staticComponentSchema).min(1),
  anchors: z.record(z.string().min(1), pointSchema),
  effectSlot: effectSlotSchema.optional(),
}).strict();
const resolvedRouteStageSchema = z.object({
  id: z.string().min(1),
  actionId: z.enum(OFFICE_CALIBRATION_ACTION_IDS),
  points: z.array(pointSchema).min(1),
  durationMs: z.number().finite().positive(),
  flipX: z.boolean(),
  reverse: z.boolean().optional(),
}).strict();
const sharedHandoffStageSchema = z.object({
  id: z.enum(OFFICE_HANDOFF_OUTBOUND_STAGE_IDS),
  actionId: z.enum(OFFICE_CALIBRATION_ACTION_IDS),
  points: z.array(pointSchema).min(1),
  durationMs: z.number().finite().positive(),
}).strict();
const resolvedHandoffSchema = z.object({
  sourceStationId: z.string().min(1),
  targetStationId: z.string().min(1),
  sharedPath: z.array(sharedHandoffStageSchema).length(OFFICE_HANDOFF_OUTBOUND_STAGE_IDS.length),
  standingTalk: pointSchema,
  seatedTalk: pointSchema,
  salute: pointSchema,
  actionMirrors: z.record(z.string().min(1), z.boolean()),
}).strict();

export const officeCalibrationDocumentSchema = z.object({
  schemaVersion: z.literal(OFFICE_CALIBRATION_SCHEMA_VERSION),
  world: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive() }).strict(),
  layers: z.array(layerSchema),
  actionVisualAlignments: z.record(z.string().min(1), actionVisualAlignmentSchema),
  transitionDirections: z.record(z.string().min(1), transitionDirectionSchema),
  stations: z.object({ columnStep: z.number().finite().positive(), items: z.array(stationSchema).min(1) }).strict(),
  stationTemplates: z.record(z.string().min(1), stationTemplateSchema),
  facilities: z.record(z.string().min(1), facilitySchema),
  routes: z.record(z.string().min(1), z.record(z.string().min(1), z.array(resolvedRouteStageSchema).min(1))),
  handoffs: z.record(z.string().min(1), z.record(z.string().min(1), resolvedHandoffSchema)),
}).strict();

const legacyLayerSchema = z.enum(["shadow", "desk", "screen", "actor", "chair", "effect"]);
const legacyHandoffStageSchema = resolvedRouteStageSchema;
const legacyHandoffSchema = z.object({
  sourceStationId: z.string().min(1),
  targetStationId: z.string().min(1),
  outbound: z.array(legacyHandoffStageSchema).min(1),
  standingTalk: pointSchema,
  seatedTalk: pointSchema,
  salute: pointSchema,
  return: z.array(legacyHandoffStageSchema).min(1),
}).strict();
const legacyOfficeCalibrationV4Schema = z.object({
  schemaVersion: z.literal(4),
  layers: z.array(legacyLayerSchema),
  handoffs: z.record(z.string().min(1), z.record(z.string().min(1), legacyHandoffSchema)),
}).passthrough();
const mirrorPatchActionSchema = z.object({
  actionId: z.enum(OFFICE_CALIBRATION_ACTION_IDS),
  flipX: z.boolean(),
}).strict();
export const officeHandoffMirrorOverridesV1Schema = z.object({
  schemaVersion: z.literal(1),
  sourceStationId: z.literal("main"),
  sourceConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
  v4Sha256: z.string().regex(/^[a-f0-9]{64}$/),
  exportedAt: z.string().min(1),
  targets: z.record(z.string().min(1), z.object({
    actions: z.record(z.string().min(1), mirrorPatchActionSchema),
  }).strict()),
}).strict();

export type OfficeCalibrationDocument = z.infer<typeof officeCalibrationDocumentSchema>;
export type OfficeCalibrationPoint = z.infer<typeof pointSchema>;
export type OfficeStaticComponent = z.infer<typeof staticComponentSchema>;
export type OfficeHandoffMirrorOverridesV1 = z.infer<typeof officeHandoffMirrorOverridesV1Schema>;

export function parseOfficeCalibrationDocument(value: unknown): Readonly<OfficeCalibrationDocument> {
  const document = officeCalibrationDocumentSchema.parse(value);
  assertOrderedKeys(document.layers, OFFICE_CALIBRATION_LAYERS, "layers");
  assertExactKeys(Object.keys(document.actionVisualAlignments), OFFICE_CALIBRATION_ACTION_IDS, "action visual alignments");
  assertExactKeys(Object.keys(document.stationTemplates), ["standard", "main"], "station templates");
  assertExactKeys(Object.keys(document.facilities), OFFICE_CALIBRATION_FACILITY_IDS, "facilities");

  assertUnique(document.stations.items.map((station) => station.stationId), "station ids");
  assertUnique(document.stations.items.map((station) => station.preferredRoleId), "preferred role ids");
  for (const station of document.stations.items) {
    if (!(station.stationTemplateId in document.stationTemplates)) {
      throw new Error(`Office station ${station.stationId} references unknown template ${station.stationTemplateId}.`);
    }
  }
  for (const [templateId, template] of Object.entries(document.stationTemplates)) {
    assertUnique(template.components.map((component) => component.componentId), `component ids in station template ${templateId}`);
    assertRequiredComponents(template.components, ["shadow", "desk", "monitor", "chair"], `station template ${templateId}`);
  }
  for (const [facilityId, facility] of Object.entries(document.facilities)) {
    assertUnique(facility.components.map((component) => component.componentId), `component ids in facility ${facilityId}`);
    assertRequiredComponents(facility.components, ["body"], `facility ${facilityId}`);
  }
  const stationIds = document.stations.items.map((station) => station.stationId);
  assertExactKeys(Object.keys(document.routes), stationIds, "facility route stations");
  assertExactKeys(Object.keys(document.handoffs), stationIds, "handoff source stations");
  for (const stationId of stationIds) {
    assertExactKeys(Object.keys(document.routes[stationId] ?? {}), OFFICE_CALIBRATION_FACILITY_IDS, `facility routes for ${stationId}`);
    assertExactKeys(Object.keys(document.handoffs[stationId] ?? {}), stationIds.filter((targetId) => targetId !== stationId), `handoff targets for ${stationId}`);
    for (const [targetId, handoff] of Object.entries(document.handoffs[stationId] ?? {})) {
      if (handoff.sourceStationId !== stationId || handoff.targetStationId !== targetId) {
        throw new Error(`Office handoff identity does not match ${stationId}/${targetId}.`);
      }
      assertOrderedKeys(handoff.sharedPath.map((stage) => stage.id), OFFICE_HANDOFF_OUTBOUND_STAGE_IDS, `handoff shared path ${stationId}/${targetId}`);
      assertExactKeys(Object.keys(handoff.actionMirrors), OFFICE_HANDOFF_ACTION_INSTANCE_IDS, `handoff action mirrors ${stationId}/${targetId}`);
    }
  }
  return deepFreeze(document);
}

export function parseOfficeCalibrationJson(source: string): Readonly<OfficeCalibrationDocument> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error("Office calibration is not valid JSON.", { cause: error });
  }
  return parseOfficeCalibrationDocument(value);
}

export function parseOfficeHandoffMirrorOverridesV1(value: unknown): Readonly<OfficeHandoffMirrorOverridesV1> {
  return deepFreeze(officeHandoffMirrorOverridesV1Schema.parse(value));
}

export function promoteOfficeCalibrationV4(
  value: unknown,
  mirrorPatchValue?: unknown,
): Readonly<OfficeCalibrationDocument> {
  const legacy = legacyOfficeCalibrationV4Schema.parse(value);
  assertOrderedKeys(legacy.layers, ["shadow", "desk", "screen", "actor", "chair", "effect"], "legacy V4 layers");
  const mirrorPatch = mirrorPatchValue == null ? null : officeHandoffMirrorOverridesV1Schema.parse(mirrorPatchValue);
  const mainTargets = Object.keys(legacy.handoffs.main ?? {});
  if (mirrorPatch) assertExactKeys(Object.keys(mirrorPatch.targets), mainTargets, "mirror patch targets");

  const handoffs = Object.fromEntries(Object.entries(legacy.handoffs).map(([sourceId, targets]) => [
    sourceId,
    Object.fromEntries(Object.entries(targets).map(([targetId, handoff]) => {
      assertLegacyReturnMatchesSharedPath(sourceId, targetId, handoff);
      const defaults = legacyHandoffActionMirrors(handoff);
      const patchActions = sourceId === "main" ? mirrorPatch?.targets[targetId]?.actions : undefined;
      if (patchActions) {
        assertExactKeys(Object.keys(patchActions), OFFICE_HANDOFF_ACTION_INSTANCE_IDS, `mirror patch actions ${targetId}`);
        for (const actionId of OFFICE_HANDOFF_ACTION_INSTANCE_IDS) {
          const expected = handoffActionId(handoff, actionId);
          if (patchActions[actionId]?.actionId !== expected) {
            throw new Error(`Office mirror patch action ${targetId}/${actionId} must use ${expected}.`);
          }
        }
      }
      return [targetId, {
        sourceStationId: handoff.sourceStationId,
        targetStationId: handoff.targetStationId,
        sharedPath: handoff.outbound.map(({ id, actionId, points, durationMs }) => ({ id, actionId, points, durationMs })),
        standingTalk: handoff.standingTalk,
        seatedTalk: handoff.seatedTalk,
        salute: handoff.salute,
        actionMirrors: patchActions
          ? Object.fromEntries(OFFICE_HANDOFF_ACTION_INSTANCE_IDS.map((id) => [id, patchActions[id]!.flipX]))
          : defaults,
      }];
    })),
  ]));

  const migrated = cloneJson(legacy) as Record<string, unknown>;
  migrated.schemaVersion = OFFICE_CALIBRATION_SCHEMA_VERSION;
  migrated.layers = [...OFFICE_CALIBRATION_LAYERS];
  migrated.handoffs = handoffs;
  migrateLegacyActorLayers(migrated);
  return parseOfficeCalibrationDocument(migrated);
}

function legacyHandoffActionMirrors(handoff: z.infer<typeof legacyHandoffSchema>): Record<OfficeHandoffActionInstanceId, boolean> {
  return {
    "depart:off-chair": false,
    ...Object.fromEntries(handoff.outbound.map((stage) => [`outbound:${stage.id}`, stage.flipX])),
    "interaction:standing-talk": false,
    "interaction:seated-talk": false,
    "interaction:salute": false,
    ...Object.fromEntries(handoff.return.map((stage) => [`return:${stage.id}`, stage.flipX])),
    "finish:off-chair": false,
  } as Record<OfficeHandoffActionInstanceId, boolean>;
}

function handoffActionId(handoff: z.infer<typeof legacyHandoffSchema>, instanceId: OfficeHandoffActionInstanceId): OfficeActionId {
  if (instanceId === "depart:off-chair" || instanceId === "finish:off-chair") return "off-chair";
  if (instanceId === "interaction:standing-talk") return "standing-talk";
  if (instanceId === "interaction:seated-talk") return "seated-talk";
  if (instanceId === "interaction:salute") return "salute";
  const [direction, stageId] = instanceId.split(":") as ["outbound" | "return", string];
  const stage = (direction === "outbound" ? handoff.outbound : handoff.return).find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`Office handoff action ${instanceId} has no matching route stage.`);
  return stage.actionId;
}

function assertLegacyReturnMatchesSharedPath(
  sourceId: string,
  targetId: string,
  handoff: z.infer<typeof legacyHandoffSchema>,
): void {
  assertOrderedKeys(handoff.outbound.map((stage) => stage.id), OFFICE_HANDOFF_OUTBOUND_STAGE_IDS, `legacy handoff outbound ${sourceId}/${targetId}`);
  assertOrderedKeys(handoff.return.map((stage) => stage.id), OFFICE_HANDOFF_RETURN_STAGE_IDS, `legacy handoff return ${sourceId}/${targetId}`);
  if ([...handoff.outbound, ...handoff.return].some((stage) => stage.reverse === true)) {
    throw new Error(`Office legacy handoff ${sourceId}/${targetId} uses reverse playback that V5 cannot represent.`);
  }
  for (let returnIndex = 0; returnIndex < handoff.return.length; returnIndex += 1) {
    const source = handoff.outbound[handoff.outbound.length - 1 - returnIndex]!;
    const returned = handoff.return[returnIndex]!;
    if (source.actionId !== returned.actionId || source.durationMs !== returned.durationMs) {
      throw new Error(`Office legacy handoff return ${sourceId}/${targetId}/${returned.id} does not match its shared outbound stage.`);
    }
    const reversedPoints = [...source.points].reverse();
    if (JSON.stringify(reversedPoints) !== JSON.stringify(returned.points)) {
      throw new Error(`Office legacy handoff return ${sourceId}/${targetId}/${returned.id} is not the exact reverse path.`);
    }
  }
}

function migrateLegacyActorLayers(document: Record<string, unknown>): void {
  const templates = document.stationTemplates as Record<string, {
    components: Array<{ layer: string }>;
    screenSlot: { layer: string };
    actorAnchor: { layer: string };
    label: { layer: string };
  }>;
  for (const template of Object.values(templates)) {
    for (const component of template.components) component.layer = migrateLegacyLayer(component.layer);
    template.screenSlot.layer = migrateLegacyLayer(template.screenSlot.layer);
    template.actorAnchor.layer = migrateLegacyLayer(template.actorAnchor.layer);
    template.label.layer = migrateLegacyLayer(template.label.layer);
  }
  const facilities = document.facilities as Record<string, {
    components: Array<{ layer: string }>;
    effectSlot?: { layer: string };
  }>;
  for (const facility of Object.values(facilities)) {
    for (const component of facility.components) component.layer = migrateLegacyLayer(component.layer);
    if (facility.effectSlot) facility.effectSlot.layer = migrateLegacyLayer(facility.effectSlot.layer);
  }
}

function migrateLegacyLayer(layer: string): string {
  return layer === "actor" ? "actor-seated" : layer;
}

function assertRequiredComponents(components: readonly OfficeStaticComponent[], required: readonly string[], owner: string): void {
  const ids = new Set(components.map((component) => component.componentId));
  for (const id of required) if (!ids.has(id)) throw new Error(`Office ${owner} is missing component ${id}.`);
}

function assertExactKeys(actual: readonly string[], expected: readonly string[], label: string): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`Office calibration ${label} must contain exactly ${right.join(", ")}.`);
  }
}

function assertOrderedKeys(actual: readonly string[], expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Office calibration ${label} must use ${expected.join(", ")} in order.`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Office calibration ${label} must be unique.`);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
