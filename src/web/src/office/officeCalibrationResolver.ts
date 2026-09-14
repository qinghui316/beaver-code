import type { OfficeCalibrationDocument } from "./officeCalibrationDocument.js";
import { OFFICE_HANDOFF_RETURN_STAGE_IDS } from "./officeCalibrationDocument.js";
import type { OfficeHandoffRoute, OfficeRouteStage, OfficeStation } from "./officeExperience.js";
import {
  OFFICE_ACTION_FRAME_COUNTS,
  officeActionPlaybackRate,
  type OfficeActionId,
  type OfficeFacilityRoute,
  type OfficeHandoffActionInstanceId,
  type OfficePoint,
} from "./officeVisualContract.js";

export class OfficeCalibrationResolver {
  private catalog: OfficeStation[] | null = null;

  constructor(readonly calibration: Readonly<OfficeCalibrationDocument>) {}

  stations(): OfficeStation[] {
    if (this.catalog) return this.catalog;
    const bases = this.calibration.stations.items.map((station, index) => {
      const template = this.template(station.stationTemplateId);
      return {
        stationId: station.stationId,
        preferredRoleId: station.preferredRoleId,
        workstationKind: station.stationTemplateId as "main" | "standard",
        index,
        origin: { ...station.origin },
        actorOffset: { ...station.actorOffset },
        anchors: {
          seat: addPoints(station.origin, template.actorAnchor.localPosition, station.actorOffset),
          keyboard: addPoints(station.origin, requiredAnchor(template.anchors, "keyboard")),
          monitor: addPoints(station.origin, requiredAnchor(template.anchors, "monitor")),
          aisleEntry: addPoints(station.origin, requiredAnchor(template.anchors, "aisleEntry")),
        },
      };
    });
    this.catalog = bases.map((base) => ({
      ...base,
      facilityRoutes: {
        coffee: this.facilityRoute(base.stationId, "coffee"),
        treadmill: this.facilityRoute(base.stationId, "treadmill"),
        toilet: this.facilityRoute(base.stationId, "toilet"),
      },
      handoffRoutes: Object.fromEntries(bases
        .filter((target) => target.stationId !== base.stationId)
        .map((target) => [target.stationId, this.handoff(base.stationId, target.stationId)])),
    }));
    return this.catalog;
  }

  stationIndex(stationId: string): number {
    const index = this.calibration.stations.items.findIndex((station) => station.stationId === stationId);
    if (index < 0) throw new Error(`Unknown Office station ${stationId}.`);
    return index;
  }

  station(stationId: string): OfficeStationGeometry {
    const station = this.calibration.stations.items[this.stationIndex(stationId)]!;
    const template = this.template(station.stationTemplateId);
    return {
      index: this.stationIndex(stationId),
      origin: { ...station.origin },
      actorAnchor: addPoints(station.origin, template.actorAnchor.localPosition, station.actorOffset),
      template,
    };
  }

  action(actionId: OfficeActionId): { scale: number; offset: OfficePoint; durationMs: number } {
    const alignment = this.calibration.actionVisualAlignments[actionId];
    return {
      scale: alignment.scale,
      offset: { ...alignment.offset },
      durationMs: actionDurationMs(actionId),
    };
  }

  facilityRoute(stationId: string, route: OfficeFacilityRoute): OfficeRouteStage[] {
    this.stationIndex(stationId);
    const stages = this.calibration.routes[stationId]?.[route];
    if (!stages) throw new Error(`Office station ${stationId} has no ${route} route.`);
    return stages.map(cloneStage);
  }

  handoff(sourceStationId: string, targetStationId: string): OfficeHandoffRoute {
    this.stationIndex(sourceStationId);
    this.stationIndex(targetStationId);
    const handoff = this.calibration.handoffs[sourceStationId]?.[targetStationId];
    if (!handoff) throw new Error(`Office station ${sourceStationId} has no handoff route to ${targetStationId}.`);
    return {
      sourceStationId: handoff.sourceStationId,
      targetStationId: handoff.targetStationId,
      outbound: handoff.sharedPath.map((stage) => ({
        ...cloneSharedHandoffStage(stage),
        flipX: handoff.actionMirrors[`outbound:${stage.id}`],
      })),
      standingTalk: { ...handoff.standingTalk },
      seatedTalk: { ...handoff.seatedTalk },
      salute: { ...handoff.salute },
      return: [...handoff.sharedPath].reverse().map((stage, index) => {
        const id = OFFICE_HANDOFF_RETURN_STAGE_IDS[index]!;
        return {
          ...cloneSharedHandoffStage(stage),
          id,
          points: [...stage.points].reverse().map((point) => ({ ...point })),
          flipX: handoff.actionMirrors[`return:${id}`],
        };
      }),
      actionMirrors: { ...handoff.actionMirrors } as Record<OfficeHandoffActionInstanceId, boolean>,
    };
  }

  stationFor(stations: readonly OfficeStation[], stationId: string): OfficeStation {
    const station = stations.find((candidate) => candidate.stationId === stationId);
    if (!station) throw new Error(`Office station ${stationId} is not present.`);
    return station;
  }

  private template(templateId: string): OfficeCalibrationDocument["stationTemplates"][string] {
    const template = this.calibration.stationTemplates[templateId];
    if (!template) throw new Error(`Unknown Office station template ${templateId}.`);
    return template;
  }
}

type OfficeStationGeometry = {
  index: number;
  origin: OfficePoint;
  actorAnchor: OfficePoint;
  template: OfficeCalibrationDocument["stationTemplates"][string];
};

function cloneStage(stage: OfficeCalibrationDocument["routes"][string][string][number]): OfficeRouteStage {
  return {
    id: stage.id,
    actionId: stage.actionId,
    points: stage.points.map((point) => ({ ...point })),
    durationMs: stage.durationMs,
    flipX: stage.flipX,
    ...(stage.reverse == null ? {} : { reverse: stage.reverse }),
  };
}

function cloneSharedHandoffStage(
  stage: OfficeCalibrationDocument["handoffs"][string][string]["sharedPath"][number],
): Omit<OfficeRouteStage, "flipX"> {
  return {
    id: stage.id,
    actionId: stage.actionId,
    points: stage.points.map((point) => ({ ...point })),
    durationMs: stage.durationMs,
  };
}

function requiredAnchor(anchors: Record<string, OfficePoint>, id: string): OfficePoint {
  const anchor = anchors[id];
  if (!anchor) throw new Error(`Office station template anchor ${id} is missing.`);
  return anchor;
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
