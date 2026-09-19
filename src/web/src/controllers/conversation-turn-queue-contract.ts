import type { ConversationQueuedTurnInput } from "../types.js";

export interface ConversationTurnQueueEnqueueInput extends ConversationQueuedTurnInput {
  expectedAccessRevision?: number;
  expectedDraftUpdatedAt: string | null;
}
