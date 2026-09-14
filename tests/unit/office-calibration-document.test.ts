import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffOfficeCalibrationFiles,
  migrateOfficeCalibrationFile,
  migrateOfficeCalibrationV3,
  promoteOfficeHandoffCalibrationFiles,
  validateOfficeCalibrationFile,
} from "../../scripts/office-calibration.js";
import {
  OFFICE_HANDOFF_ACTION_INSTANCE_IDS,
  parseOfficeCalibrationDocument,
  parseOfficeCalibrationJson,
  promoteOfficeCalibrationV4,
  type OfficeCalibrationDocument,
} from "../../src/web/src/office/officeCalibrationDocument.js";
import { OFFICE_SCENE_CALIBRATION, serializeOfficeSceneCalibration } from "../../scripts/office-calibration-v3.js";
import { officeVerificationFixturePath } from "../helpers/office-verification-fixture.js";

const legacyCalibrationPath = officeVerificationFixturePath("calibration", "scene-calibration-v3.json");
const atlasPath = "src/web/public/agent-office/props/office-props@1x.webp.json";
const highResolutionAtlasPath = "src/web/public/agent-office/props/office-props@2x.webp.json";
const shadowProofPath = "design-assets/agent-office/approved/shadows/baked-shadow-calibration.json";
const documentPath = "src/web/public/agent-office/config/office-calibration.json";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Office calibration document", () => {
  it("migrates v3 into one strict v5 document without changing authored routes or visible prop geometry", async () => {
    const legacy = JSON.parse(await readFile(legacyCalibrationPath, "utf8"));
    const atlas = JSON.parse(await readFile(atlasPath, "utf8"));
    const shadowProof = JSON.parse(await readFile(shadowProofPath, "utf8"));
    const highResolutionAtlas = JSON.parse(await readFile(highResolutionAtlasPath, "utf8"));
    const document = migrateOfficeCalibrationV3(legacy, atlas, shadowProof, highResolutionAtlas);

    expect(document.schemaVersion).toBe(5);
    expect(document.layers).toEqual(["shadow", "desk", "screen", "actor-seated", "chair", "actor-mobile", "effect"]);
    const published = parseOfficeCalibrationJson(await readFile(documentPath, "utf8"));
    expect(document.routes).toEqual(published.routes);
    expect(document.handoffs.planning).toEqual(published.handoffs.planning);
    expect(document.stations.items.map((station) => station.stationId)).toEqual(legacy.roster.seats.map((seat: { slotId: string }) => seat.slotId));
    expect(document.actionVisualAlignments.working).toEqual({
      scale: legacy.actionScales.working,
      offset: legacy.actionOffsets.working,
    });

    for (const templateId of ["standard", "main"] as const) {
      const template = document.stationTemplates[templateId]!;
      const legacyTemplate = legacy.workstations[templateId];
      for (const [componentId, legacyId] of [["desk", legacyTemplate.deskId], ["monitor", "standard-monitor"], ["chair", legacyTemplate.chairId]] as const) {
        const component = template.components.find((candidate) => candidate.componentId === componentId)!;
        const transform = legacyTemplate[componentId];
        const trim = atlas.frames[`${legacyId}.png`].spriteSourceSize;
        expect(component.localPosition.x + trim.x * component.scale.x).toBeCloseTo(transform.x, 12);
        expect(component.localPosition.y + trim.y * component.scale.y).toBeCloseTo(transform.y, 12);
      }
    }

    for (const templateId of ["standard", "main"] as const) {
      expect(component(document, templateId, "shadow").localPosition).toEqual(component(published, templateId, "shadow").localPosition);
    }
    for (const facilityId of ["coffee", "treadmill"] as const) {
      const actual = facilityComponent(document, facilityId, "shadow").localPosition;
      const expected = facilityComponent(published, facilityId, "shadow").localPosition;
      expect(actual.x).toBeCloseTo(expected.x, 12);
      expect(actual.y).toBeCloseTo(expected.y, 12);
    }

    for (const facilityId of ["coffee", "treadmill", "toilet"] as const) {
      const facility = document.facilities[facilityId]!;
      expect(facility.components.find((candidate) => candidate.componentId === "body")?.localPosition).toEqual({ x: 0, y: 0 });
      for (const [anchorId, local] of Object.entries(facility.anchors)) {
        expect(facility.origin.x + local.x).toBeCloseTo(legacy.facilities[facilityId].anchors[anchorId].x, 12);
        expect(facility.origin.y + local.y).toBeCloseTo(legacy.facilities[facilityId].anchors[anchorId].y, 12);
      }
    }
    expect(document.facilities.coffee?.anchors.aisleEntry).toEqual({
      x: legacy.facilities.coffee.anchors.aisleEntry.x - legacy.facilities.coffee.origin.x,
      y: legacy.facilities.coffee.anchors.aisleEntry.y - legacy.facilities.coffee.origin.y,
    });
    expect(document.facilities.toilet?.components.find((candidate) => candidate.componentId === "toilet-paper")?.localPosition).toEqual({
      x: legacy.facilities.toiletPaper.origin.x - legacy.facilities.toilet.origin.x,
      y: legacy.facilities.toiletPaper.origin.y - legacy.facilities.toilet.origin.y,
    });

    const movedGeometry = structuredClone(document);
    movedGeometry.stations.items[0]!.origin.x += 100;
    movedGeometry.facilities.coffee!.origin.x += 100;
    const reparsed = parseOfficeCalibrationDocument(movedGeometry);
    expect(reparsed.routes).toEqual(document.routes);
    expect(reparsed.handoffs).toEqual(document.handoffs);
  });

  it("accepts only schema v5, rejects unknown structure, and deeply freezes the parsed document", async () => {
    const source = await readFile(documentPath, "utf8");
    const document = parseOfficeCalibrationJson(source);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.facilities.coffee?.components)).toBe(true);
    expect(Object.isFrozen(document.routes.main?.coffee)).toBe(true);

    const old = { ...JSON.parse(source), schemaVersion: 3 };
    expect(() => parseOfficeCalibrationDocument(old)).toThrow(/schemaVersion/i);
    const unknown = { ...JSON.parse(source), compatibilityFallback: true };
    expect(() => parseOfficeCalibrationDocument(unknown)).toThrow(/unrecognized key/i);
    const invalidResource = structuredClone(JSON.parse(source));
    invalidResource.stationTemplates.standard.components = invalidResource.stationTemplates.standard.components.filter(
      (candidate: { componentId: string }) => candidate.componentId !== "chair",
    );
    expect(() => parseOfficeCalibrationDocument(invalidResource)).toThrow(/missing component chair/i);

    const v4 = demoteToV4(document);
    expect(() => parseOfficeCalibrationDocument(v4)).toThrow(/schemaVersion/i);
    const missingMirror = structuredClone(document);
    delete missingMirror.handoffs.main.planning.actionMirrors["finish:off-chair"];
    expect(() => parseOfficeCalibrationDocument(missingMirror)).toThrow(/action mirrors/i);
    const reorderedLayers = structuredClone(document);
    [reorderedLayers.layers[3], reorderedLayers.layers[4]] = [reorderedLayers.layers[4]!, reorderedLayers.layers[3]!];
    expect(() => parseOfficeCalibrationDocument(reorderedLayers)).toThrow(/layers must use/i);
  });

  it("promotes V4 shared routes and independent action mirrors deterministically", async () => {
    const published = parseOfficeCalibrationJson(await readFile(documentPath, "utf8"));
    const v4 = demoteToV4(published);
    const patch = mirrorPatchFromV5(published, "0".repeat(64));
    const promoted = promoteOfficeCalibrationV4(v4, patch);
    expect(promoted).toEqual(published);
    expect(Object.keys(promoted.handoffs.main.planning.actionMirrors)).toEqual(expect.arrayContaining([...OFFICE_HANDOFF_ACTION_INSTANCE_IDS]));

    const mismatched = structuredClone(patch);
    mismatched.targets.planning.actions["interaction:salute"].actionId = "working";
    expect(() => promoteOfficeCalibrationV4(v4, mismatched)).toThrow(/must use salute/i);

    const driftedReturn = structuredClone(v4);
    driftedReturn.handoffs.main.planning.return[0].points[0].x += 1;
    expect(() => promoteOfficeCalibrationV4(driftedReturn, patch)).toThrow(/exact reverse path/i);

    const unrepresentableReverse = structuredClone(v4);
    unrepresentableReverse.handoffs.main.planning.return[0].reverse = true;
    expect(() => promoteOfficeCalibrationV4(unrepresentableReverse, patch)).toThrow(/cannot represent/i);
  });

  it("verifies the exact V4 byte identity before writing a promoted V5 file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aho-office-handoff-promotion-"));
    temporaryDirectories.push(directory);
    const published = parseOfficeCalibrationJson(await readFile(documentPath, "utf8"));
    const v4Source = `${JSON.stringify(demoteToV4(published), null, 2)}\n`;
    const v4Path = join(directory, "office-v4.json");
    const patchPath = join(directory, "mirror-patch.json");
    const targetPath = join(directory, "office-v5.json");
    const v4Hash = createHash("sha256").update(v4Source).digest("hex");
    await writeFile(v4Path, v4Source, "utf8");
    await writeFile(patchPath, `${JSON.stringify(mirrorPatchFromV5(published, v4Hash), null, 2)}\n`, "utf8");

    const result = await promoteOfficeHandoffCalibrationFiles(v4Path, patchPath, targetPath);
    expect(result.sourceV4Sha256).toBe(v4Hash);
    expect(parseOfficeCalibrationJson(await readFile(targetPath, "utf8"))).toEqual(published);

    const mismatched = mirrorPatchFromV5(published, "f".repeat(64));
    await writeFile(patchPath, JSON.stringify(mismatched), "utf8");
    const before = await readFile(targetPath, "utf8");
    await expect(promoteOfficeHandoffCalibrationFiles(v4Path, patchPath, targetPath)).rejects.toThrow(/do not match/i);
    expect(await readFile(targetPath, "utf8")).toBe(before);
  });

  it("writes migrations atomically with a previous-document backup and leaves invalid input untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aho-office-calibration-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "office-calibration.json");
    const legacyPath = join(directory, "scene-calibration-v3.json");
    const previous = await readFile(documentPath, "utf8");
    await writeFile(legacyPath, serializeOfficeSceneCalibration(OFFICE_SCENE_CALIBRATION), "utf8");
    await writeFile(target, previous, "utf8");

    const result = await migrateOfficeCalibrationFile(legacyPath, target, atlasPath);
    expect(result.backupPath).toBe(`${target}.bak`);
    expect(await readFile(`${target}.bak`, "utf8")).toBe(previous);
    const migrated = await readFile(target, "utf8");
    expect(() => parseOfficeCalibrationJson(migrated)).not.toThrow();

    const invalidLegacy = join(directory, "invalid-v3.json");
    await writeFile(invalidLegacy, JSON.stringify({ schemaVersion: 2 }), "utf8");
    const before = await readFile(target, "utf8");
    await expect(migrateOfficeCalibrationFile(invalidLegacy, target, atlasPath)).rejects.toThrow(/schemaVersion must be 3/i);
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it("validates and diffs without rewriting either source document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aho-office-calibration-diff-"));
    temporaryDirectories.push(directory);
    const source = await readFile(documentPath, "utf8");
    const left = join(directory, "left.json");
    const right = join(directory, "right.json");
    const changed = structuredClone(JSON.parse(source));
    changed.facilities.coffee.components[0].alpha = 0.9;
    await writeFile(left, source, "utf8");
    await writeFile(right, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    const beforeLeft = await readFile(left, "utf8");
    const validation = await validateOfficeCalibrationFile(left);
    expect(validation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await diffOfficeCalibrationFiles(left, left)).toEqual([]);
    expect(await diffOfficeCalibrationFiles(left, right)).toEqual([
      "$.facilities.coffee.components[0].alpha: 1 -> 0.9",
    ]);
    expect(await readFile(left, "utf8")).toBe(beforeLeft);
  });
});

function component(document: Readonly<OfficeCalibrationDocument>, templateId: "standard" | "main", componentId: string) {
  return document.stationTemplates[templateId]!.components.find((candidate) => candidate.componentId === componentId)!;
}

function facilityComponent(document: Readonly<OfficeCalibrationDocument>, facilityId: "coffee" | "treadmill", componentId: string) {
  return document.facilities[facilityId]!.components.find((candidate) => candidate.componentId === componentId)!;
}

function demoteToV4(document: Readonly<OfficeCalibrationDocument>) {
  const legacy = structuredClone(document) as unknown as Record<string, unknown> & {
    schemaVersion: number;
    layers: string[];
    stationTemplates: Record<string, { components: Array<{ layer: string }>; screenSlot: { layer: string }; actorAnchor: { layer: string }; label: { layer: string } }>;
    facilities: Record<string, { components: Array<{ layer: string }>; effectSlot?: { layer: string } }>;
    handoffs: Record<string, Record<string, Record<string, unknown> & { sharedPath: Array<{ id: string; actionId: string; points: Array<{ x: number; y: number }>; durationMs: number }>; actionMirrors: Record<string, boolean> }>>;
  };
  legacy.schemaVersion = 4;
  legacy.layers = ["shadow", "desk", "screen", "actor", "chair", "effect"];
  for (const template of Object.values(legacy.stationTemplates)) {
    for (const component of template.components) if (component.layer === "actor-seated") component.layer = "actor";
    if (template.screenSlot.layer === "actor-seated") template.screenSlot.layer = "actor";
    if (template.actorAnchor.layer === "actor-seated") template.actorAnchor.layer = "actor";
    if (template.label.layer === "actor-seated") template.label.layer = "actor";
  }
  for (const facility of Object.values(legacy.facilities)) {
    for (const component of facility.components) if (component.layer === "actor-seated") component.layer = "actor";
    if (facility.effectSlot?.layer === "actor-seated") facility.effectSlot.layer = "actor";
  }
  for (const targets of Object.values(legacy.handoffs)) {
    for (const handoff of Object.values(targets)) {
      const sharedPath = handoff.sharedPath;
      const mirrors = handoff.actionMirrors;
      handoff.outbound = sharedPath.map((stage) => ({
        ...stage,
        points: stage.points.map((point) => ({ ...point })),
        flipX: mirrors[`outbound:${stage.id}`],
      }));
      const returnIds = ["walk-target-depart", "walk-source-row", "walk-source-approach", "source-leaving-return"];
      handoff.return = [...sharedPath].reverse().map((stage, index) => ({
        ...stage,
        id: returnIds[index],
        points: [...stage.points].reverse().map((point) => ({ ...point })),
        flipX: mirrors[`return:${returnIds[index]}`],
        reverse: false,
      }));
      delete handoff.sharedPath;
      delete handoff.actionMirrors;
    }
  }
  return legacy;
}

function mirrorPatchFromV5(document: Readonly<OfficeCalibrationDocument>, v4Sha256: string) {
  return {
    schemaVersion: 1 as const,
    sourceStationId: "main" as const,
    sourceConfigSha256: "0".repeat(64),
    v4Sha256,
    exportedAt: "2026-09-14T00:00:00.000Z",
    targets: Object.fromEntries(Object.entries(document.handoffs.main).map(([targetId, handoff]) => [targetId, {
      actions: Object.fromEntries(OFFICE_HANDOFF_ACTION_INSTANCE_IDS.map((instanceId) => [instanceId, {
        actionId: actionIdForInstance(handoff.sharedPath, instanceId),
        flipX: handoff.actionMirrors[instanceId],
      }])),
    }])),
  };
}

function actionIdForInstance(
  sharedPath: Readonly<OfficeCalibrationDocument>["handoffs"][string][string]["sharedPath"],
  instanceId: (typeof OFFICE_HANDOFF_ACTION_INSTANCE_IDS)[number],
) {
  if (instanceId === "depart:off-chair" || instanceId === "finish:off-chair") return "off-chair";
  if (instanceId === "interaction:standing-talk") return "standing-talk";
  if (instanceId === "interaction:seated-talk") return "seated-talk";
  if (instanceId === "interaction:salute") return "salute";
  const [direction, stageId] = instanceId.split(":");
  const sourceIndex = direction === "outbound"
    ? ["source-leaving-out", "walk-source-corridor", "walk-target-row", "walk-target-approach"].indexOf(stageId!)
    : 3 - ["walk-target-depart", "walk-source-row", "walk-source-approach", "source-leaving-return"].indexOf(stageId!);
  return sharedPath[sourceIndex]!.actionId;
}
