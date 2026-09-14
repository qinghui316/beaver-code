export type OfficePoint = { x: number; y: number };
export type OfficeLayerId = "shadow" | "desk" | "screen" | "actor-seated" | "chair" | "actor-mobile" | "effect";
export type OfficeActorDepthMode = "seated" | "mobile";

export const OFFICE_ACTION_IDS = [
  "working",
  "standby",
  "coffee-drink",
  "peek",
  "off-chair",
  "walk-horizontal",
  "walk-vertical",
  "leaving",
  "treadmill",
  "toilet",
  "standing-talk",
  "seated-talk",
  "salute",
] as const;

export type OfficeActionId = (typeof OFFICE_ACTION_IDS)[number];

export const OFFICE_ACTION_FRAME_COUNTS: Record<OfficeActionId, number> = {
  working: 68,
  standby: 62,
  "coffee-drink": 79,
  peek: 48,
  "off-chair": 34,
  "walk-horizontal": 49,
  "walk-vertical": 8,
  leaving: 21,
  treadmill: 45,
  toilet: 121,
  "standing-talk": 76,
  "seated-talk": 86,
  salute: 76,
};

export type OfficeFacilityRoute = "coffee" | "treadmill" | "toilet";
export type OfficeRouteStageId =
  | "off-chair-out" | "leaving-out" | "walk-out" | "facility-use"
  | "facility-reverse" | "walk-return" | "leaving-return" | "off-chair-return";
export type OfficeMovingRouteStageId = "leaving-out" | "walk-out" | "walk-return" | "leaving-return";
export type OfficeHandoffMovingStageId =
  | "source-leaving-out" | "walk-source-corridor" | "walk-target-row" | "walk-target-approach"
  | "walk-target-depart" | "walk-source-row" | "walk-source-approach" | "source-leaving-return";
export type OfficeHandoffOutboundStageId =
  | "source-leaving-out" | "walk-source-corridor" | "walk-target-row" | "walk-target-approach";
export type OfficeHandoffReturnStageId =
  | "walk-target-depart" | "walk-source-row" | "walk-source-approach" | "source-leaving-return";
export type OfficeHandoffActionInstanceId =
  | "depart:off-chair"
  | `outbound:${OfficeHandoffOutboundStageId}`
  | "interaction:standing-talk"
  | "interaction:seated-talk"
  | "interaction:salute"
  | `return:${OfficeHandoffReturnStageId}`
  | "finish:off-chair";

export function officeActionPlaybackRate(actionId: string): number {
  return actionId === "walk-vertical" ? 0.5 : 1;
}

export const OFFICE_SCREEN_ANIMATION_SPEED = 0.35;

export type OfficeRuntimeVisualCommand =
  | { kind: "setActorDepth"; actorId: string; mode: OfficeActorDepthMode }
  | { kind: "playAction"; actorId: string; actionId: OfficeActionId; loop?: boolean; reverse?: boolean; flipX?: boolean; phase?: number; durationMs?: number }
  | { kind: "playRouteStage"; actorId: string; routeId: string; actionId: OfficeActionId; points: OfficePoint[]; durationMs: number; loop?: boolean; reverse?: boolean; flipX?: boolean }
  | { kind: "followRoute"; actorId: string; routeId: string; points: OfficePoint[]; durationMs: number; flipX?: boolean }
  | { kind: "setScreen"; stationId: string; profile: "off" | "static" | "orchestration" | "entertainment-1" | "entertainment-2"; phase?: number }
  | { kind: "setEffect"; actorId: string; effect: "none" | "attention" | "blocked" | "failed" | "interrupted" | "coffee-cup"; durationMs?: number }
  | { kind: "showParticipant"; actorId: string }
  | { kind: "hideParticipant"; actorId: string }
  | { kind: "sequence"; commands: OfficeRuntimeVisualCommand[] }
  | { kind: "parallel"; commands: OfficeRuntimeVisualCommand[] };
