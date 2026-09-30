import type { ConversationTurnQueueSnapshot } from "../types.js";
import type {
  ConversationComposerPorts,
  ConversationComposerResourcePorts,
  ConversationDraftLifecyclePorts,
  ConversationExecutionActionPorts,
  ConversationSubmissionCoordinatorPorts,
  DeepReadonly,
} from "./conversation-composer-contract.js";

export interface ConversationComposerPortViews {
  readonly draft: ConversationDraftLifecyclePorts;
  readonly resources: ConversationComposerResourcePorts;
  readonly submission: ConversationSubmissionCoordinatorPorts;
  readonly execution: ConversationExecutionActionPorts;
}

export function createConversationComposerPortViews(ports: ConversationComposerPorts): ConversationComposerPortViews {
  const draft: ConversationDraftLifecyclePorts = Object.freeze({
    drafts: ports.drafts ? Object.freeze({
      load: (projectId: string, productMode: Parameters<NonNullable<typeof ports.drafts>["load"]>[1]) => (
        ports.drafts!.load(projectId, productMode)
      ),
      save: (input: Parameters<NonNullable<typeof ports.drafts>["save"]>[0]) => ports.drafts!.save(input),
      delete: (input: Parameters<NonNullable<typeof ports.drafts>["delete"]>[0]) => ports.drafts!.delete(input),
    }) : undefined,
    session: Object.freeze({
      restoreDraftProvider: ports.session.restoreDraftProvider
        ? (providerId: string | null) => ports.session.restoreDraftProvider!(providerId)
        : undefined,
      selectProvider: ports.session.selectProvider
        ? (providerId: string) => ports.session.selectProvider!(providerId)
        : undefined,
    }),
    onError: (message: string | null) => ports.onError(message),
  });

  const resources: ConversationComposerResourcePorts = Object.freeze({
    skills: ports.skills ? Object.freeze({
      load: async (...args: Parameters<NonNullable<typeof ports.skills>["load"]>) => ports.skills!.load(...args),
      setEnabled: (...args: Parameters<NonNullable<typeof ports.skills>["setEnabled"]>) => ports.skills!.setEnabled(...args),
    }) : undefined,
    attachments: ports.attachments ? Object.freeze({
      upload: (...args: Parameters<NonNullable<typeof ports.attachments>["upload"]>) => ports.attachments!.upload(...args),
      remove: (...args: Parameters<NonNullable<typeof ports.attachments>["remove"]>) => ports.attachments!.remove(...args),
    }) : undefined,
    onError: (message: string | null) => ports.onError(message),
  });

  const operation = () => Object.freeze({
    begin: (key: string) => ports.operation.begin(key),
    release: (token: Parameters<typeof ports.operation.release>[0]) => ports.operation.release(token),
  });
  const ids = ports.ids ? Object.freeze({
    createClientRequestId: () => ports.ids!.createClientRequestId(),
  }) : undefined;

  const submission: ConversationSubmissionCoordinatorPorts = Object.freeze({
    operation: operation(),
    ids,
    session: Object.freeze({
      ensureProjectRegistered: (projectId: string) => ports.session.ensureProjectRegistered(projectId),
      createConversation: (request: Parameters<typeof ports.session.createConversation>[0]) => ports.session.createConversation(request),
      beginPendingConversation: ports.session.beginPendingConversation
        ? (input: Parameters<NonNullable<typeof ports.session.beginPendingConversation>>[0]) => ports.session.beginPendingConversation!(input)
        : undefined,
    }),
    actions: Object.freeze({
      sendMessage: ports.actions.sendMessage
        ? (request: Parameters<NonNullable<typeof ports.actions.sendMessage>>[0]) => ports.actions.sendMessage!(request)
        : undefined,
    }),
    timeline: Object.freeze({
      calibrate: (...args: Parameters<typeof ports.timeline.calibrate>) => ports.timeline.calibrate(...args),
      showPending: ports.timeline.showPending
        ? (...args: Parameters<NonNullable<typeof ports.timeline.showPending>>) => ports.timeline.showPending!(...args)
        : undefined,
      markPending: ports.timeline.markPending
        ? (...args: Parameters<NonNullable<typeof ports.timeline.markPending>>) => ports.timeline.markPending!(...args)
        : undefined,
      consumePending: ports.timeline.consumePending
        ? (...args: Parameters<NonNullable<typeof ports.timeline.consumePending>>) => ports.timeline.consumePending!(...args)
        : undefined,
      rekeyPending: ports.timeline.rekeyPending
        ? (...args: Parameters<NonNullable<typeof ports.timeline.rekeyPending>>) => ports.timeline.rekeyPending!(...args)
        : undefined,
    }),
    projection: Object.freeze({
      refreshConversation: (...args: Parameters<typeof ports.projection.refreshConversation>) => ports.projection.refreshConversation(...args),
      routeEvent: ports.projection.routeEvent
        ? (...args: Parameters<NonNullable<typeof ports.projection.routeEvent>>) => ports.projection.routeEvent!(...args)
        : undefined,
    }),
    attachments: ports.attachments ? Object.freeze({
      upload: (...args: Parameters<NonNullable<typeof ports.attachments>["upload"]>) => ports.attachments!.upload(...args),
      remove: (...args: Parameters<NonNullable<typeof ports.attachments>["remove"]>) => ports.attachments!.remove(...args),
    }) : undefined,
    onError: (message: string | null) => ports.onError(message),
  });

  const execution: ConversationExecutionActionPorts = Object.freeze({
    operation: operation(),
    ids,
    actions: Object.freeze({
      stop: (request: Parameters<typeof ports.actions.stop>[0]) => ports.actions.stop(request),
    }),
    timeline: Object.freeze({
      calibrate: (...args: Parameters<typeof ports.timeline.calibrate>) => ports.timeline.calibrate(...args),
    }),
    queue: ports.queue ? Object.freeze({
      snapshot: readonlyQueueSnapshot(ports.queue.snapshot),
      loading: ports.queue.loading,
      enqueue: async (input: Parameters<typeof ports.queue.enqueue>[0]) => readonlyQueueSnapshot(await ports.queue!.enqueue(input)),
      reclaim: async (...args: Parameters<typeof ports.queue.reclaim>) => readonlyQueueSnapshot(await ports.queue!.reclaim(...args)),
    }) : undefined,
    onError: (message: string | null) => ports.onError(message),
  });

  return Object.freeze({ draft, resources, submission, execution });
}

function readonlyQueueSnapshot(
  snapshot: ConversationTurnQueueSnapshot | null,
): DeepReadonly<ConversationTurnQueueSnapshot> | null {
  if (!snapshot) return null;
  return deepFreeze(structuredClone(snapshot)) as DeepReadonly<ConversationTurnQueueSnapshot>;
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, visited);
  return Object.freeze(value);
}
