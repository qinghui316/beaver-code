import { consumeWorkbenchLiveStream, WorkbenchRequestError } from "../api.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type { TopicAttachment, WorkbenchLiveEvent } from "../types.js";
import type { ComposerDraftCheckpoint, ComposerDraftContent } from "./ComposerDraftSyncOwner.js";
import type {
  ComposerAttachmentUpload,
  ComposerCreateConversationRequest,
  ComposerCreatedConversation,
  ComposerMessageRequest,
  ConversationSubmissionPorts,
  ConversationSubmissionScope,
  ConversationSubmissionSkillIdentity,
} from "./conversation-submission-contract.js";

export interface ConversationSubmissionCompositionInput {
  operation(): ConversationSubmissionPorts["operation"];
  ids(): ConversationSubmissionPorts["ids"];
  session(): {
    ensureProjectRegistered(projectId: string): Promise<string | null>;
    createConversation(request: ComposerCreateConversationRequest): Promise<ComposerCreatedConversation>;
    beginPendingConversation?: ConversationSubmissionPorts["session"]["beginPendingConversation"];
  };
  actions(): { sendMessage?(request: ComposerMessageRequest): Promise<void> };
  timeline(): {
    showPending?(scope: ConversationSubmissionScope, clientRequestId: string, text: string): void;
    markPending?(scope: ConversationSubmissionScope, clientRequestId: string, state: "sending" | "uncertain" | "failed", failure?: string): void;
    consumePending?(scope: ConversationSubmissionScope, clientRequestId: string): void;
    rekeyPending?(from: ConversationSubmissionScope, to: ConversationSubmissionScope, clientRequestId: string): void;
    calibrate(projectId: string, conversationId: string, agentSurfaceId: "main-agent"): Promise<void>;
  };
  projection(): {
    refreshConversation(projectId: string, conversationId: string): Promise<void>;
    routeEvent?(projectId: string, event: WorkbenchLiveEvent): void;
  };
  attachments(): {
    upload(projectId: string, upload: ComposerAttachmentUpload): Promise<TopicAttachment>;
    remove(projectId: string, attachmentId: string): Promise<void>;
  };
  drafts(): {
    checkpoint(projectId: string, productMode: ConversationSubmissionScope["productMode"]): ComposerDraftCheckpoint;
    flush(projectId: string, productMode: ConversationSubmissionScope["productMode"]): Promise<string | null>;
    settleAccepted(
      accepted: ComposerDraftContent,
      checkpoint: ComposerDraftCheckpoint,
      mutationToken: string | null,
    ): Promise<void>;
  };
  skills(): {
    apply(identity: ConversationSubmissionSkillIdentity, overrides: Record<string, boolean>): Promise<void>;
    reload(identity: ConversationSubmissionSkillIdentity): Promise<void>;
  };
  onError(message: string | null): void;
}

export function createConversationSubmissionPorts(
  input: ConversationSubmissionCompositionInput,
): ConversationSubmissionPorts {
  return {
    operation: {
      begin: (key) => input.operation().begin(key),
      release: (token) => input.operation().release(token),
    },
    ids: { createClientRequestId: () => input.ids().createClientRequestId() },
    session: {
      ensureProjectRegistered: (projectId) => input.session().ensureProjectRegistered(projectId),
      createConversation: (request) => input.session().createConversation(request),
      beginPendingConversation: (pending) => input.session().beginPendingConversation?.(pending),
    },
    transport: {
      sendMessage: (request, routeEvent) => {
        const customTransport = input.actions().sendMessage;
        return customTransport
          ? customTransport(request)
          : sendConversationMessageTransport(request, routeEvent);
      },
    },
    timeline: {
      showPending: (scope, clientRequestId, text) => input.timeline().showPending?.(scope, clientRequestId, text),
      markPending: (scope, clientRequestId, state, failure) => input.timeline().markPending?.(scope, clientRequestId, state, failure),
      consumePending: (scope, clientRequestId) => input.timeline().consumePending?.(scope, clientRequestId),
      rekeyPending: (from, to, clientRequestId) => input.timeline().rekeyPending?.(from, to, clientRequestId),
      calibrate: (projectId, conversationId, agentSurfaceId) => input.timeline().calibrate(projectId, conversationId, agentSurfaceId),
    },
    projection: {
      refreshConversation: (projectId, conversationId) => input.projection().refreshConversation(projectId, conversationId),
      routeEvent: (projectId, event) => input.projection().routeEvent?.(projectId, event),
    },
    attachments: {
      upload: (projectId, upload) => input.attachments().upload(projectId, upload),
      remove: (projectId, attachmentId) => input.attachments().remove(projectId, attachmentId),
    },
    drafts: {
      checkpoint: (projectId, productMode) => input.drafts().checkpoint(projectId, productMode),
      flush: (projectId, productMode) => input.drafts().flush(projectId, productMode),
      settleAccepted: (accepted, checkpoint, mutationToken) => (
        input.drafts().settleAccepted(accepted, checkpoint, mutationToken)
      ),
    },
    skills: {
      apply: (identity, overrides) => input.skills().apply(identity, overrides),
      reload: (identity) => input.skills().reload(identity),
    },
    errors: {
      describe: (cause) => userFacingErrorMessage(cause, "send"),
      classify: classifySubmissionFailure,
    },
    onError: input.onError,
  };
}

async function sendConversationMessageTransport(
  request: ComposerMessageRequest,
  routeEvent?: (projectId: string, event: WorkbenchLiveEvent) => void,
): Promise<void> {
  await consumeWorkbenchLiveStream<WorkbenchLiveEvent>(
    `/api/projects/${encodeURIComponent(request.projectId)}/workbench/topics/${encodeURIComponent(request.conversationId)}/messages/live`,
    {
      mode: "chat",
      clientRequestId: request.clientRequestId,
      message: request.message,
      contextRefs: request.contextRefs,
      attachmentIds: request.attachmentIds,
      providerId: request.providerId,
      providerSwitchIntent: request.providerSwitchIntent,
      productMode: request.productMode,
      agentTurnMode: request.agentTurnMode,
      agentAccessMode: request.agentAccessMode,
      expectedAccessRevision: request.expectedAccessRevision,
      modelId: request.modelId,
      reasoningEffort: request.reasoningEffort,
    },
    (event) => routeEvent?.(request.projectId, event),
  );
}

function classifySubmissionFailure(cause: unknown, transportStarted: boolean): "failed" | "uncertain" {
  if (!transportStarted) return "failed";
  if (cause instanceof WorkbenchRequestError) {
    return cause.status === 408 || cause.status >= 500 ? "uncertain" : "failed";
  }
  return "uncertain";
}
