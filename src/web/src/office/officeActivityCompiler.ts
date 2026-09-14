import {
  stablePhase,
  type OfficeBehaviorActor,
  type OfficeBehaviorIntent,
  type OfficeSeatedBehaviorIntent,
} from "./officeBehaviorPolicy.js";
import { OfficeCalibrationResolver } from "./officeCalibrationResolver.js";
import type { OfficeAmbientIntent, OfficeFacilityId, OfficeHandoffRoute, OfficeRouteStage, OfficeStation } from "./officeExperience.js";
import type { OfficeActorDepthMode, OfficePoint, OfficeRuntimeVisualCommand } from "./officeVisualContract.js";

export class OfficeActivityCompiler {
  constructor(private readonly resolver: OfficeCalibrationResolver) {}

  behaviorAtStation(
    actor: OfficeBehaviorActor,
    intent: OfficeBehaviorIntent,
    station: OfficeStation,
    previousStationId?: string,
  ): OfficeRuntimeVisualCommand {
    return {
      kind: "sequence",
      commands: [
        ...(previousStationId && previousStationId !== station.stationId ? [this.vacateStation(previousStationId)] : []),
        this.positionFirstAction(this.behavior(actor, intent), actor.actorId, "canonical-seat", station.anchors.seat),
      ],
    };
  }

  actorExit(actorId: string, stationId: string | null, turnOffStation: boolean): OfficeRuntimeVisualCommand {
    return {
      kind: "parallel",
      commands: [
        { kind: "hideParticipant", actorId },
        ...(stationId && turnOffStation ? [this.vacateStation(stationId)] : []),
        this.clearEffect(actorId),
      ],
    };
  }

  vacateStation(stationId: string): OfficeRuntimeVisualCommand {
    return { kind: "setScreen", stationId, profile: "off" };
  }

  clearEffect(actorId: string): OfficeRuntimeVisualCommand {
    return { kind: "setEffect", actorId, effect: "none" };
  }

  dispatch(
    mainActorId: string,
    childActorId: string,
    mainStationId: string,
    route: OfficeHandoffRoute,
  ): OfficeRuntimeVisualCommand {
    return {
      kind: "sequence",
      commands: [
        this.actorDepth(mainActorId, "mobile"),
        { kind: "playAction", actorId: mainActorId, actionId: "off-chair", loop: false, flipX: route.actionMirrors["depart:off-chair"], durationMs: this.resolver.action("off-chair").durationMs },
        this.vacateStation(mainStationId),
        ...route.outbound.map((stage) => this.routeStage(mainActorId, stage)),
        { kind: "parallel", commands: [
          { kind: "sequence", commands: [
            this.actorDepth(mainActorId, "mobile"),
            this.positionedAction(mainActorId, "handoff:standing-talk", "standing-talk", route.standingTalk, this.resolver.action("standing-talk").durationMs, { flipX: route.actionMirrors["interaction:standing-talk"] }),
          ] },
          { kind: "sequence", commands: [
            this.actorDepth(childActorId, "seated"),
            this.positionedAction(childActorId, "handoff:seated-talk", "seated-talk", route.seatedTalk, this.resolver.action("seated-talk").durationMs, { flipX: route.actionMirrors["interaction:seated-talk"] }),
          ] },
        ] },
        { kind: "sequence", commands: [
          this.actorDepth(childActorId, "seated"),
          this.positionedAction(childActorId, "handoff:salute", "salute", route.salute, this.resolver.action("salute").durationMs, { flipX: route.actionMirrors["interaction:salute"] }),
        ] },
        ...route.return.map((stage) => this.routeStage(mainActorId, stage)),
        { kind: "playAction", actorId: mainActorId, actionId: "off-chair", reverse: true, loop: false, flipX: route.actionMirrors["finish:off-chair"], durationMs: this.resolver.action("off-chair").durationMs },
        this.actorDepth(mainActorId, "seated"),
      ],
    };
  }

  behavior(actor: OfficeBehaviorActor, intent: OfficeBehaviorIntent): OfficeRuntimeVisualCommand {
    if (intent.kind === "seated") return this.seated(actor, intent.seated);
    return {
      kind: "sequence",
      commands: [
        this.actorDepth(actor.actorId, "seated"),
        { kind: "setScreen", stationId: actor.stationId, profile: screenProfile(intent.seated.screen), phase: stablePhase(actor.actorId) },
        { kind: "setEffect", actorId: actor.actorId, effect: intent.seated.effect },
        { kind: "playAction", actorId: actor.actorId, actionId: "salute", loop: false, durationMs: this.resolver.action("salute").durationMs },
        { kind: "playAction", actorId: actor.actorId, actionId: "working", loop: true, phase: stablePhase(actor.actorId) },
      ],
    };
  }

  seated(actor: OfficeBehaviorActor, intent: OfficeSeatedBehaviorIntent): OfficeRuntimeVisualCommand {
    return {
      kind: "parallel",
      commands: [
        this.actorDepth(actor.actorId, "seated"),
        { kind: "playAction", actorId: actor.actorId, actionId: "working", loop: true, phase: stablePhase(actor.actorId) },
        { kind: "setScreen", stationId: actor.stationId, profile: screenProfile(intent.screen), phase: stablePhase(actor.actorId) },
        { kind: "setEffect", actorId: actor.actorId, effect: intent.effect },
      ],
    };
  }

  ambient(actorId: string, station: OfficeStation, intent: OfficeAmbientIntent): OfficeRuntimeVisualCommand {
    switch (intent.kind) {
      case "look-around":
        return { kind: "sequence", commands: [
          this.actorDepth(actorId, "seated"),
          { kind: "playAction", actorId, actionId: "standby", loop: false, durationMs: this.resolver.action("standby").durationMs },
        ] };
      case "facility":
        return this.facilityActivity(actorId, station, intent.facilityId);
      case "desk":
        if (intent.activity === "peek") {
          return { kind: "sequence", commands: [
            this.actorDepth(actorId, "seated"),
            { kind: "playAction", actorId, actionId: "peek", loop: false, durationMs: this.resolver.action("peek").durationMs },
          ] };
        }
        return { kind: "sequence", commands: [
          this.actorDepth(actorId, "seated"),
          { kind: "playAction", actorId, actionId: "coffee-drink", loop: false, durationMs: this.resolver.action("coffee-drink").durationMs },
        ] };
      default:
        return assertNever(intent);
    }
  }

  private facilityActivity(
    actorId: string,
    station: OfficeStation,
    facility: OfficeFacilityId,
  ): OfficeRuntimeVisualCommand {
    const stages = station.facilityRoutes[facility];
    return {
      kind: "sequence",
      commands: [
        this.actorDepth(actorId, "mobile"),
        ...stages.slice(0, 1).map((stage) => this.routeStage(actorId, stage)),
        { kind: "setScreen", stationId: station.stationId, profile: "off" },
        ...stages.slice(1).map((stage) => this.routeStage(actorId, stage, facility === "coffee" && stage.id === "facility-use")),
        this.actorDepth(actorId, "seated"),
      ],
    };
  }

  routeStage(actorId: string, stage: OfficeRouteStage, coffeeEffect = false): OfficeRuntimeVisualCommand {
    const commands: OfficeRuntimeVisualCommand[] = [
      {
        kind: "playRouteStage",
        actorId,
        routeId: stage.id,
        actionId: stage.actionId,
        points: stage.points,
        durationMs: stage.durationMs,
        loop: stage.id === "walk-out" || stage.id === "walk-return" || stage.id.includes("walk-"),
        reverse: stage.reverse,
        flipX: stage.flipX,
      },
    ];
    if (coffeeEffect) commands.push({ kind: "setEffect", actorId, effect: "coffee-cup", durationMs: stage.durationMs });
    return commands.length === 1 ? commands[0]! : { kind: "parallel", commands };
  }

  positionedAction(
    actorId: string,
    routeId: string,
    actionId: Extract<OfficeRuntimeVisualCommand, { kind: "playAction" }>["actionId"],
    point: OfficePoint,
    durationMs: number,
    command: Partial<Extract<OfficeRuntimeVisualCommand, { kind: "playAction" }>> = {},
  ): Extract<OfficeRuntimeVisualCommand, { kind: "playRouteStage" }> {
    return {
      kind: "playRouteStage",
      actorId,
      routeId,
      actionId,
      points: [point],
      durationMs,
      loop: command.loop ?? false,
      reverse: command.reverse,
      flipX: command.flipX,
    };
  }

  private positionFirstAction(
    command: OfficeRuntimeVisualCommand,
    actorId: string,
    routeId: string,
    point: OfficePoint,
  ): OfficeRuntimeVisualCommand {
    if (command.kind === "playAction" && command.actorId === actorId) {
      return this.positionedAction(actorId, routeId, command.actionId, point, command.durationMs ?? 0, command);
    }
    if (command.kind !== "sequence" && command.kind !== "parallel") return command;
    let positioned = false;
    const commands = command.commands.map((child) => {
      if (positioned) return child;
      const next = this.positionFirstAction(child, actorId, routeId, point);
      positioned = next !== child;
      return next;
    });
    return positioned ? { ...command, commands } : command;
  }

  private actorDepth(actorId: string, mode: OfficeActorDepthMode): Extract<OfficeRuntimeVisualCommand, { kind: "setActorDepth" }> {
    return { kind: "setActorDepth", actorId, mode };
  }
}

function screenProfile(screen: OfficeSeatedBehaviorIntent["screen"]): Extract<OfficeRuntimeVisualCommand, { kind: "setScreen" }>["profile"] {
  if (screen === "work") return "orchestration";
  return screen === "game-1" ? "entertainment-1" : "entertainment-2";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Office ambient intent: ${String(value)}`);
}
