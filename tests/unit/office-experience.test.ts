import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OfficeBehaviorPolicy, leisureScreen, participantBehaviorActor, residentBehaviorActor } from "../../src/web/src/office/officeBehaviorPolicy.js";
import { OfficeActivityCompiler } from "../../src/web/src/office/officeActivityCompiler.js";
import { OfficeCalibrationResolver } from "../../src/web/src/office/officeCalibrationResolver.js";
import { parseOfficeCalibrationJson } from "../../src/web/src/office/officeCalibrationDocument.js";
import { AgentSurfaceOfficeSourceAdapter, mapAgentSurfaceState } from "../../src/web/src/office/agentSurfaceOfficeSourceAdapter.js";
import { OfficeExperienceComposer } from "../../src/web/src/office/officeExperienceComposer.js";
import { OfficeOccupancyPolicy } from "../../src/web/src/office/officeOccupancyPolicy.js";
import { OfficeStationAssignmentStore } from "../../src/web/src/office/officeStationAssignmentStore.js";
import type { AgentCatalogDisplayProjection, AgentSurfaceProjection, AgentSurfaceStatus } from "../../src/web/src/types.js";

const calibration = parseOfficeCalibrationJson(readFileSync("src/web/public/agent-office/config/office-calibration.json", "utf8"));
const resolver = new OfficeCalibrationResolver(calibration);

describe("Office experience boundary", () => {
  it("maps every canonical Agent status at the sole adapter boundary", () => {
    expect(["idle", "queued", "running", "waiting-user", "needs-change", "failed", "completed", "interrupted", "terminated"].map((status) => mapAgentSurfaceState(status as AgentSurfaceStatus)))
      .toEqual(["idle", "queued", "working", "attention", "blocked", "failed", "completed", "interrupted", "idle"]);
  });

  it("keeps nine spatial stations and creates participants only for current non-terminated surfaces", () => {
    const snapshot = adapter().hydrate(projection([
      child("historical", "coder-agent", "completed", 1, { scopeRange: "historical", graphScopeId: "scope-old", readOnly: true }),
      child("closed", "auditor-agent", "terminated", 2, { readOnly: true }),
    ]));
    expect(snapshot.stations).toHaveLength(9);
    expect(snapshot.participants.map((participant) => participant.participantId)).toEqual(["main-agent"]);
  });

  it("fills an empty current Office with the Catalog-backed Evolution resident", () => {
    const snapshot = adapter(undefined, residentCatalog()).hydrate(projection([]));
    expect(snapshot.participants.map((participant) => participant.participantId)).toEqual(["main-agent"]);
    expect(snapshot.residents.map((resident) => resident.residentId)).toEqual(["resident:harness-evolution-agent"]);
    expect(snapshot.residents.map((resident) => resident.stationId)).toEqual(["evolution"]);
    expect(snapshot.residents.every((resident) => !("navigationId" in resident))).toBe(true);
  });

  it("does not add Harness residents to Agent mode Office", () => {
    const agent = projection([]);
    agent.productMode = "agent";
    const snapshot = adapter(undefined, residentCatalog()).hydrate(agent);
    expect(snapshot.participants.map((participant) => participant.participantId)).toEqual(["main-agent"]);
    expect(snapshot.residents).toEqual([]);
  });

  it("suppresses the Evolution resident when a real Evolution Agent is visible", () => {
    const unrelated = adapter(undefined, residentCatalog()).hydrate(projection([child("coder-1", "coder-agent", "completed", 1)]));
    expect(unrelated.residents.map((resident) => resident.roleId)).toEqual(["harness-evolution-agent"]);

    const sameRole = adapter(undefined, residentCatalog()).hydrate(projection([child("evolution-1", "harness-evolution-agent", "idle", 1)]));
    expect(sameRole.residents).toEqual([]);

    const twoReal = adapter(undefined, residentCatalog()).hydrate(projection([
      child("coder-1", "coder-agent", "idle", 1),
      child("auditor-1", "auditor-agent", "completed", 2),
    ]));
    expect(twoReal.residents).toEqual([]);
  });

  it("keeps residents in the current terminal Office while omitting missing Catalog roles", () => {
    const terminal = projection([]);
    terminal.scopeStatus = "terminal";
    const catalog = residentCatalog();
    catalog.roles = catalog.roles.slice(0, 1);
    expect(adapter(undefined, catalog).hydrate(terminal).residents.map((resident) => resident.roleId)).toEqual(["harness-evolution-agent"]);
  });

  it("persists a displaced resident station without automatically returning to its preferred station", () => {
    const storage = new MemoryStorage();
    const office = adapter(storage, residentCatalog());
    const occupied = projection([child("evolution-station-occupant", "coder-agent", "running", 1)]);
    const preferredStation = resolver.stations().find((station) => station.preferredRoleId === "harness-evolution-agent")!.stationId;
    const key = `aho:agent-office:station-assignments:v1:project-1:conversation-1:scope-1`;
    storage.setItem(key, JSON.stringify({ version: 1, assignments: { "evolution-station-occupant": preferredStation } }));
    const first = office.hydrate(occupied);
    const fallback = first.residents.find((resident) => resident.roleId === "harness-evolution-agent")!.stationId;
    expect(fallback).not.toBe(preferredStation);
    const afterDeparture = office.reconcile(occupied, projection([])).snapshot;
    expect(afterDeparture.residents.find((resident) => resident.roleId === "harness-evolution-agent")?.stationId).toBe(fallback);
    expect(adapter(storage, residentCatalog()).hydrate(projection([])).residents.find((resident) => resident.roleId === "harness-evolution-agent")?.stationId).toBe(fallback);
  });

  it("keeps role-owned screen, desk, and facility preferences independent of the selected station", () => {
    const snapshot = adapter().hydrate(projection([child("child-1", "coder-agent", "completed", 1)]));
    const coder = snapshot.participants.find((participant) => participant.participantId === "child-1")!;
    expect(coder.presentationPreferences.screens).toEqual([{ id: "game-1", weight: 3 }, { id: "game-2", weight: 1 }]);
    expect(coder.presentationPreferences.desk.map((preference) => preference.id)).toEqual(["peek", "drink-at-desk"]);
    expect(coder.presentationPreferences.facilities).toEqual([
      { id: "coffee", weight: 1 },
      { id: "treadmill", weight: 3 },
      { id: "toilet", weight: 1 },
    ]);
  });

  it("gives unknown roles equal positive access to every facility", () => {
    const snapshot = adapter().hydrate(projection([child("custom-1", "custom-role", "idle", 1)]));
    expect(snapshot.participants.find((participant) => participant.participantId === "custom-1")?.presentationPreferences.facilities).toEqual([
      { id: "coffee", weight: 1 },
      { id: "treadmill", weight: 1 },
      { id: "toilet", weight: 1 },
    ]);
  });

  it("gives one duplicate role its preferred station and keeps the other on roster fallback", () => {
    const office = adapter();
    const first = projection([
      child("planning-1", "planning-agent", "running", 1),
      child("planning-2", "planning-agent", "running", 2),
    ]);
    const before = office.hydrate(first);
    const firstStation = before.participants.find((participant) => participant.participantId === "planning-1")!.stationId;
    const secondStation = before.participants.find((participant) => participant.participantId === "planning-2")!.stationId;
    expect(firstStation).toBe("planning");
    expect(secondStation).not.toBe("planning");

    const after = office.reconcile(first, projection([child("planning-2", "planning-agent", "running", 2)])).snapshot;
    expect(after.participants.find((participant) => participant.participantId === "planning-2")?.stationId).toBe(secondStation);
  });

  it("persists assignments across adapter refresh without reading any legacy key", () => {
    const storage = new MemoryStorage();
    storage.setItem("aho:agent-office:station-assignments", JSON.stringify({ assignments: { "planning-2": "planning" } }));
    const firstProjection = projection([
      child("planning-1", "planning-agent", "running", 1),
      child("planning-2", "planning-agent", "running", 2),
    ]);
    const first = adapter(storage).hydrate(firstProjection);
    const assignment = new Map(first.participants.map((participant) => [participant.participantId, participant.stationId]));
    const refreshed = adapter(storage).hydrate({ ...firstProjection, surfaces: [firstProjection.surfaces[0]!, ...firstProjection.surfaces.slice(1).reverse()] });
    expect(new Map(refreshed.participants.map((participant) => [participant.participantId, participant.stationId]))).toEqual(assignment);
    expect(assignment.get("planning-1")).toBe("planning");
  });

  it("assigns the same stations for reordered opaque provider-neutral actor ids", () => {
    const children = [
      child("agent:codex:thread:z", "planning-agent", "running", 2),
      child("agent:claude:session:a", "planning-agent", "running", 1),
      child("ordinary-agent-7", "custom-role", "idle", 3),
    ];
    const forward = adapter().hydrate(projection(children));
    const reverse = adapter().hydrate(projection([...children].reverse()));
    expect(forward.participants.map((participant) => participant.participantId))
      .toEqual(reverse.participants.map((participant) => participant.participantId));
    expect(new Map(forward.participants.map((participant) => [participant.participantId, participant.stationId])))
      .toEqual(new Map(reverse.participants.map((participant) => [participant.participantId, participant.stationId])));
    expect(forward.participants.find((participant) => participant.participantId === "agent:claude:session:a")?.stationId).toBe("planning");
  });

  it("yields a completed station to active overflow without moving active occupants", () => {
    const office = adapter();
    const firstChildren = [
      ...ROLE_IDS.map((roleId, index) => child(`agent-${index}`, roleId, index === 0 ? "completed" : "running", index)),
      child("agent-default", "custom-existing-role", "running", ROLE_IDS.length),
    ];
    const first = projection(firstChildren);
    const firstSnapshot = office.hydrate(first);
    const stationByActive = new Map(firstSnapshot.participants.map((participant) => [participant.participantId, participant.stationId]));
    const overflow = projection([...firstChildren, child("agent-new", "custom-role", "running", 20)]);
    const result = office.reconcile(first, overflow).snapshot;
    expect(result.participants).toHaveLength(9);
    expect(result.participants.some((participant) => participant.participantId === "agent-0")).toBe(false);
    expect(result.participants.some((participant) => participant.participantId === "agent-new")).toBe(true);
    for (const participant of result.participants.filter((candidate) => candidate.participantId !== "agent-new" && candidate.kind === "child")) {
      expect(participant.stationId).toBe(stationByActive.get(participant.participantId));
    }
    expect(result.diagnostics[0]).toContain("agent-0");
  });

  it("emits live creation while scope replacement only resets", () => {
    const office = adapter();
    const empty = projection([]);
    office.hydrate(empty);
    const added = projection([child("child-1", ROLE_IDS[0]!, "queued", 1)]);
    expect(office.reconcile(empty, added).events).toEqual([{ kind: "participant-added", participantId: "child-1", parentParticipantId: "main-agent" }]);
    const nextScope = projection([child("child-1", ROLE_IDS[0]!, "queued", 1, { graphScopeId: "scope-2" })], "scope-2");
    expect(office.reconcile(added, nextScope).events).toEqual([{ kind: "scope-reset", previousContextId: "scope-1" }]);
  });

  it("binds semantic states without letting role choice affect coordinates", () => {
    const policy = new OfficeBehaviorPolicy();
    const compiler = new OfficeActivityCompiler(resolver);
    const participant = adapter().hydrate(projection([child("child-1", ROLE_IDS[1]!, "running", 1)])).participants[1]!;
    const actor = participantBehaviorActor(participant);
    const command = compiler.behavior(actor, policy.resolve(actor));
    expect(command).toMatchObject({ kind: "parallel" });
    expect(command.kind === "parallel" ? command.commands : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "setActorDepth", actorId: participant.participantId, mode: "seated" }),
      expect.objectContaining({ kind: "playAction", actionId: "working" }),
      expect.objectContaining({ kind: "setScreen", stationId: participant.stationId, profile: "orchestration" }),
    ]));
  });

  it("loops one computer-use base action and separates work from game screens", () => {
    const policy = new OfficeBehaviorPolicy();
    const compiler = new OfficeActivityCompiler(resolver);
    const base = adapter().hydrate(projection([child("child-1", ROLE_IDS[1]!, "running", 1)])).participants[1]!;
    base.presentationPreferences.screens = [
      { id: "game-1", weight: 3 },
      { id: "game-2", weight: 1 },
    ];
    for (const state of ["queued", "idle", "completed", "attention", "blocked", "failed", "interrupted"] as const) {
      const actor = participantBehaviorActor({ ...base, state });
      const command = compiler.behavior(actor, policy.resolve(actor));
      expect(command.kind).toBe("parallel");
      if (command.kind !== "parallel") continue;
      expect(command.commands).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "playAction", actionId: "working", loop: true }),
        expect.objectContaining({ kind: "setScreen", stationId: base.stationId, profile: "entertainment-1" }),
      ]));
    }

    const workingActor = participantBehaviorActor({ ...base, state: "working" });
    const working = compiler.behavior(workingActor, policy.resolve(workingActor));
    expect(working.kind === "parallel" ? working.commands : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "playAction", actionId: "working", loop: true }),
      expect.objectContaining({ kind: "setScreen", stationId: base.stationId, profile: "orchestration" }),
    ]));

    const completedActor = participantBehaviorActor({ ...base, state: "completed" });
    expect(compiler.behavior(completedActor, policy.resolve(completedActor, true))).toMatchObject({ kind: "sequence", commands: [
      { kind: "setActorDepth", actorId: "child-1", mode: "seated" },
      { kind: "setScreen", profile: "entertainment-1" },
      { kind: "setEffect", effect: "none" },
      { kind: "playAction", actionId: "salute", loop: false },
      { kind: "playAction", actionId: "working", loop: true },
    ] });

    const resident = adapter(undefined, residentCatalog()).hydrate(projection([])).residents[0]!;
    const residentActor = residentBehaviorActor(resident);
    const residentCommand = compiler.behavior(residentActor, policy.resolve(residentActor));
    expect(residentCommand.kind === "parallel" ? residentCommand.commands : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "playAction", actionId: "working", loop: true }),
      expect.objectContaining({ kind: "setScreen", stationId: resident.stationId, profile: "entertainment-1" }),
    ]));
  });

  it("uses weighted entertainment preference and a stable identity fallback", () => {
    expect(leisureScreen("preferred", [
      { id: "game-1", weight: 1 },
      { id: "game-2", weight: 3 },
    ])).toBe("game-2");
    expect(leisureScreen("single", [{ id: "game-1", weight: 1 }])).toBe("game-1");
    const fallback = leisureScreen("stable-actor", [
      { id: "game-1", weight: 1 },
      { id: "game-2", weight: 1 },
    ]);
    expect(leisureScreen("stable-actor", [])).toBe(fallback);
  });

  it("compiles every ambient intent through one semantic-to-material owner", () => {
    const compiler = new OfficeActivityCompiler(resolver);
    const station = resolver.stations().find((candidate) => candidate.stationId === "coder")!;

    expect(compiler.ambient("actor-1", station, { kind: "look-around" })).toMatchObject({ kind: "sequence", commands: [
      { kind: "setActorDepth", actorId: "actor-1", mode: "seated" },
      { kind: "playAction", actorId: "actor-1", actionId: "standby", loop: false },
    ] });
    expect(compiler.ambient("actor-1", station, { kind: "desk", activity: "peek" })).toMatchObject({ kind: "sequence", commands: [
      { kind: "setActorDepth", actorId: "actor-1", mode: "seated" },
      { kind: "playAction", actionId: "peek", loop: false },
    ] });
    expect(compiler.ambient("actor-1", station, { kind: "desk", activity: "drink-at-desk" })).toMatchObject({ kind: "sequence", commands: [
      { kind: "setActorDepth", actorId: "actor-1", mode: "seated" },
      { kind: "playAction", actionId: "coffee-drink", loop: false },
    ] });
    for (const facilityId of ["coffee", "treadmill", "toilet"] as const) {
      const command = compiler.ambient("actor-1", station, { kind: "facility", facilityId });
      expect(command).toMatchObject({ kind: "sequence" });
      expect(command.kind === "sequence" ? command.commands : []).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "setScreen", stationId: station.stationId, profile: "off" }),
        expect.objectContaining({ kind: "playRouteStage", actorId: "actor-1" }),
      ]));
    }
    expect(() => compiler.ambient("actor-1", station, { kind: "future" } as never)).toThrow(
      "Unsupported Office ambient intent: [object Object]",
    );
  });

  it("uses station-owned anchors, actor offsets, handoffs, and facility routes", () => {
    const stations = resolver.stations();
    expect(calibration.schemaVersion).toBe(5);
    expect(calibration.actionVisualAlignments.working.offset).toEqual({ x: -7.881743332435346, y: -1.9704132831742616 });
    for (const station of stations) {
      expect(station.anchors.seat).toEqual(resolver.station(station.stationId).actorAnchor);
      expect(Object.keys(station.facilityRoutes)).toEqual(["coffee", "treadmill", "toilet"]);
      for (const route of Object.values(station.facilityRoutes)) {
        expect(route[0]?.id).toBe("off-chair-out");
        expect(route.at(-1)?.id).toBe("off-chair-return");
      }
    }
    const main = stations.find((station) => station.stationId === "main")!;
    expect(Object.keys(main.handoffRoutes)).toHaveLength(8);
  });

  it("keeps world coordinates out of role presentation and action switching", async () => {
    const sharedOwners = ["officeExperience.ts", "officeOccupancyPolicy.ts", "officeBehaviorPolicy.ts", "officeCalibrationResolver.ts", "choreographyEngine.ts", "ambientScheduler.ts", "officeDirector.ts", "PixiOfficeRenderer.tsx"];
    for (const owner of sharedOwners) {
      const source = await readFile(new URL(`../../src/web/src/office/${owner}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from .*workbench|Provider|from ["']\.\.\/types/);
    }
    const renderer = await readFile(new URL("../../src/web/src/office/PixiOfficeRenderer.tsx", import.meta.url), "utf8");
    const applyAction = renderer.slice(renderer.indexOf("async function applyAction"), renderer.indexOf("function applyActionVisual"));
    expect(applyAction).not.toMatch(/group\.position|group\.x|group\.y/);
  });
});

const ROLE_IDS = ["planning-agent", "coder-agent", "auditor-agent", "rework-coder", "spec-test-proposer", "spec-test-generator", "harness-evolution-agent"];

function adapter(storage?: Storage, catalog: AgentCatalogDisplayProjection | null = null): TestOfficeAdapter {
  return new TestOfficeAdapter(storage, catalog);
}

class TestOfficeAdapter {
  private readonly source = new AgentSurfaceOfficeSourceAdapter();
  private readonly experience: OfficeExperienceComposer;

  constructor(storage?: Storage, catalog: AgentCatalogDisplayProjection | null = null) {
    this.experience = new OfficeExperienceComposer(
      "project-1",
      resolver,
      catalog,
      new OfficeOccupancyPolicy(new OfficeStationAssignmentStore(storage ?? null)),
    );
  }

  hydrate(projection: AgentSurfaceProjection) {
    return this.experience.hydrate(this.source.project(projection));
  }

  reconcile(previous: AgentSurfaceProjection, next: AgentSurfaceProjection) {
    return this.experience.reconcile(this.source.project(previous), this.source.project(next));
  }
}

function residentCatalog(): AgentCatalogDisplayProjection {
  return {
    version: "1.0",
    catalogHash: "catalog-residents",
    roles: [
      { roleId: "harness-evolution-agent", displayName: "Harness Evolution Agent", description: "Evolves the harness.", skills: ["aho-harness-engineering"] },
    ],
  };
}

function projection(children: AgentSurfaceProjection["surfaces"], graphScopeId = "scope-1"): AgentSurfaceProjection {
  return {
    projectId: "project-1",
    productMode: "harness",
    conversationId: "conversation-1",
    graphScopeId,
    scopeStatus: "active",
    projectionHash: `${graphScopeId}:${children.map((surface) => `${surface.agentSurfaceId}:${surface.status}`).join("|")}`,
    surfaces: [main(graphScopeId), ...children],
    diagnostics: [],
  };
}

function main(graphScopeId: string): AgentSurfaceProjection["surfaces"][number] {
  return surface("main-agent", "main-agent", "idle", 0, { kind: "main-agent", parentAgentSurfaceId: null, graphScopeId });
}

function child(id: string, roleId: string, status: AgentSurfaceStatus, index: number, overrides: Partial<AgentSurfaceProjection["surfaces"][number]> = {}): AgentSurfaceProjection["surfaces"][number] {
  return surface(id, roleId, status, index, overrides);
}

function surface(id: string, roleId: string, status: AgentSurfaceStatus, index: number, overrides: Partial<AgentSurfaceProjection["surfaces"][number]>): AgentSurfaceProjection["surfaces"][number] {
  return {
    agentSurfaceId: id,
    kind: "agent",
    roleId,
    roleDisplayName: roleId,
    label: id,
    description: "",
    skills: [],
    parentAgentSurfaceId: "main-agent",
    graphScopeId: "scope-1",
    scopeRange: "current",
    status,
    readOnly: false,
    createdAt: `2026-07-18T00:00:${String(index + 1).padStart(2, "0")}Z`,
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
