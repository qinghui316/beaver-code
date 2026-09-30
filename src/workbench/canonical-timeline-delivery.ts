import type { WorkbenchDatabase } from "./persistence/database.js";
import type { StoredTopicMessage, StoredTopicMessageWrite } from "./persistence/contracts.js";
import type { WorkbenchLiveSink } from "./types.js";
import type { CanonicalTimelineEnvelope } from "./canonical-timeline-contract.js";
import { projectCanonicalTimelineEnvelope } from "./canonical-timeline-projector.js";
import type { ProductMode } from "../provider-runtime/index.js";

export type CanonicalTimelinePublisher = (envelope: CanonicalTimelineEnvelope) => void;

export class CanonicalTimelineDelivery {
  constructor(
    private readonly database: WorkbenchDatabase,
    private readonly productMode: ProductMode,
    private readonly target?: WorkbenchLiveSink | CanonicalTimelinePublisher,
  ) {}

  append(message: StoredTopicMessageWrite): CanonicalTimelineEnvelope {
    return this.publishCommitted(this.database.timeline.appendMessage(message));
  }

  update(message: StoredTopicMessageWrite): CanonicalTimelineEnvelope {
    return this.publishCommitted(this.database.timeline.updateMessage(message));
  }

  upsert(message: StoredTopicMessageWrite): CanonicalTimelineEnvelope {
    const existing = this.database.timeline.readMessage(message.projectId, message.conversationId, message.id);
    return existing ? this.update(message) : this.append(message);
  }

  publishCommitted(row: StoredTopicMessage): CanonicalTimelineEnvelope {
    return publishCommittedCanonicalTimelineRow(this.target, row, this.productMode, (id) => this.database.timeline.readMessage(row.projectId, row.conversationId, id));
  }

  publishCommittedMany(rows: readonly StoredTopicMessage[]): CanonicalTimelineEnvelope[] {
    return rows.map((row) => this.publishCommitted(row));
  }
}

export function publishCanonicalTimelineEnvelope(
  live: WorkbenchLiveSink | undefined,
  envelope: CanonicalTimelineEnvelope,
): void {
  try {
    live?.emit({ event: "timeline.patch", data: envelope });
  } catch {
    // SQLite is authoritative; latest-page calibration repairs transport loss.
  }
}

export function publishCommittedCanonicalTimelineRow(
  target: WorkbenchLiveSink | CanonicalTimelinePublisher | undefined,
  row: StoredTopicMessage,
  productMode: ProductMode,
  resolveSource?: (id: string) => StoredTopicMessage | null,
): CanonicalTimelineEnvelope {
  const envelope = projectCanonicalTimelineEnvelope(row, productMode, resolveSource);
  try {
    if (typeof target === "function") target(envelope);
    else target?.emit({ event: "timeline.patch", data: envelope });
  } catch {
    // Publication is best-effort after commit and must not change business state.
  }
  return envelope;
}
