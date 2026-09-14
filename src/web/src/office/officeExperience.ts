export type OfficeParticipantState =
  | "idle"
  | "queued"
  | "working"
  | "attention"
  | "blocked"
  | "failed"
  | "completed"
  | "interrupted";

export type OfficeWeightedPreference<T extends string> = { id: T; weight: number };
export type OfficeDeskActivityId = "peek" | "drink-at-desk";
export type OfficeFacilityId = "coffee" | "treadmill" | "toilet";
export type OfficeLeisureScreenId = "game-1" | "game-2";
export type OfficePresentationPreferences = {
  screens: OfficeWeightedPreference<OfficeLeisureScreenId>[];
  desk: OfficeWeightedPreference<OfficeDeskActivityId>[];
  facilities: OfficeWeightedPreference<OfficeFacilityId>[];
};
export type OfficeAmbientIntent =
  | { kind: "look-around" }
  | { kind: "desk"; activity: OfficeDeskActivityId }
  | { kind: "facility"; facilityId: OfficeFacilityId };
export type OfficeScarfId = "main" | "planning" | "coder" | "auditor" | "rework" | "spec-test-proposer" | "spec-test-generator" | "maintenance" | "evolution" | "default";

export type OfficePoint = { x: number; y: number };
export type OfficeWorkstationAnchors = {
  seat: OfficePoint;
  keyboard: OfficePoint;
  monitor: OfficePoint;
  aisleEntry: OfficePoint;
};
export type OfficeRouteStage = {
  id: string;
  actionId: import("./officeVisualContract.js").OfficeActionId;
  points: OfficePoint[];
  durationMs: number;
  flipX: boolean;
  reverse?: boolean;
};
export type OfficeHandoffRoute = {
  sourceStationId: string;
  targetStationId: string;
  outbound: OfficeRouteStage[];
  standingTalk: OfficePoint;
  seatedTalk: OfficePoint;
  salute: OfficePoint;
  return: OfficeRouteStage[];
  actionMirrors: Record<import("./officeVisualContract.js").OfficeHandoffActionInstanceId, boolean>;
};

export type OfficeStation = {
  stationId: string;
  preferredRoleId: string;
  workstationKind: "main" | "standard";
  index: number;
  origin: OfficePoint;
  actorOffset: OfficePoint;
  anchors: OfficeWorkstationAnchors;
  facilityRoutes: Record<"coffee" | "treadmill" | "toilet", OfficeRouteStage[]>;
  handoffRoutes: Record<string, OfficeHandoffRoute>;
};

export type OfficeParticipant = {
  participantId: string;
  navigationId: string | null;
  stationId: string;
  kind: "main" | "child";
  label: string;
  roleId: string;
  parentParticipantId: string | null;
  state: OfficeParticipantState;
  createdAt: string;
  scarf: OfficeScarfId;
  presentationPreferences: OfficePresentationPreferences;
};

export type OfficeResident = {
  residentId: string;
  roleId: string;
  label: string;
  stationId: string;
  scarf: OfficeScarfId;
  presentationPreferences: OfficePresentationPreferences;
};

export type OfficeExperienceSnapshot = {
  contextId: string;
  revision: string;
  lifecycle: "active" | "terminal";
  stations: OfficeStation[];
  participants: OfficeParticipant[];
  residents: OfficeResident[];
  diagnostics: string[];
};

export type OfficeActorSourceItem = {
  actorId: string;
  actorKind: "primary" | "worker";
  navigationId: string | null;
  roleId: string;
  label: string;
  parentActorId: string | null;
  state: OfficeParticipantState;
  createdAt: string;
};

export type OfficeActorSourceSnapshot = {
  conversationId: string;
  contextId: string;
  revision: string;
  lifecycle: "active" | "terminal";
  residentPolicy?: "harness-catalog" | "none";
  actors: OfficeActorSourceItem[];
};

export type OfficeSemanticEvent =
  | { kind: "scope-reset"; previousContextId: string }
  | { kind: "participant-added"; participantId: string; parentParticipantId: string | null }
  | { kind: "participant-removed"; participantId: string }
  | { kind: "station-changed"; participantId: string; fromStationId: string; toStationId: string }
  | { kind: "state-changed"; participantId: string; from: OfficeParticipantState; to: OfficeParticipantState }
  | { kind: "resident-added"; residentId: string }
  | { kind: "resident-removed"; residentId: string }
  | { kind: "resident-station-changed"; residentId: string; fromStationId: string; toStationId: string }
  | { kind: "scope-terminal" };

export interface OfficeActorSourceAdapter<TProjection> {
  project(projection: TProjection): OfficeActorSourceSnapshot;
}
