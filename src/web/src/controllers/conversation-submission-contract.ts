import type { AgentTurnMode, ProductMode, TopicAttachment, TopicFileReference, WorkbenchLiveEvent } from "../types.js";
import type { ComposerDraftCheckpoint, ComposerDraftContent } from "./ComposerDraftSyncOwner.js";
import type { WorkbenchOperationToken } from "./useGlobalOperationGate.js";

export interface DraftSubmissionSnapshot {
  agentAccessMode?: import("./conversation-access-contract.js").AgentAccessMode;
  expectedAccessRevision?: number;
  projectId: string;
  productMode: ProductMode;
  conversationId: string | null;
  clientRequestId: string;
  draftRevision: string | null;
  text: string;
  contextRefs: TopicFileReference[];
  attachmentIds: string[];
  skillOverrides: Record<string, boolean>;
  providerId: string | null;
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
}

export interface ComposerSkillOverride {
  skillId: string;
  enabled: boolean;
}

export interface ComposerCreateConversationRequest {
  agentAccessMode?: import("./conversation-access-contract.js").AgentAccessMode;
  projectId: string;
  productMode: ProductMode;
  clientRequestId: string;
  body: string;
  contextRefs: TopicFileReference[];
  attachmentIds: string[];
  providerId?: string;
  skillOverrides: ComposerSkillOverride[];
  agentTurnMode?: AgentTurnMode;
  modelId?: string | null;
  reasoningEffort?: string | null;
  showPendingBeforeCreate: boolean;
}

export interface ComposerCreatedConversation {
  projectId: string;
  conversationId: string;
}

export interface ComposerMessageRequest {
  agentAccessMode?: import("./conversation-access-contract.js").AgentAccessMode;
  expectedAccessRevision?: number;
  clientRequestId: string;
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  message: string;
  contextRefs: TopicFileReference[];
  attachmentIds: string[];
  providerId?: string;
  providerSwitchIntent?: "resume-workflow";
  agentTurnMode?: AgentTurnMode;
  modelId?: string | null;
  reasoningEffort?: string | null;
}

export interface ComposerAttachmentUpload {
  fileName: string;
  mediaType: string;
  data: string;
}

export interface ConversationSubmissionScope {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
}

export interface ConversationSubmissionSkillIdentity {
  projectId: string;
  productMode: ProductMode;
  conversationId: string | null;
  providerId: string | null;
}

export interface ConversationSubmissionPorts {
  operation: {
    begin(key: string): WorkbenchOperationToken;
    release(token: WorkbenchOperationToken): void;
  };
  ids: { createClientRequestId(): string };
  session: {
    ensureProjectRegistered(projectId: string): Promise<string | null>;
    createConversation(request: ComposerCreateConversationRequest): Promise<ComposerCreatedConversation>;
    beginPendingConversation?(input: {
      id: string;
      projectId: string;
      productMode: ProductMode;
      clientRequestId: string;
      title: string;
      body: string;
      selectedProviderId?: string;
    }): void;
  };
  transport: {
    sendMessage(request: ComposerMessageRequest, routeEvent?: (projectId: string, event: WorkbenchLiveEvent) => void): Promise<void>;
  };
  timeline: {
    showPending?(scope: ConversationSubmissionScope, clientRequestId: string, text: string): void;
    markPending?(scope: ConversationSubmissionScope, clientRequestId: string, state: "sending" | "uncertain" | "failed", failure?: string): void;
    consumePending?(scope: ConversationSubmissionScope, clientRequestId: string): void;
    rekeyPending?(from: ConversationSubmissionScope, to: ConversationSubmissionScope, clientRequestId: string): void;
    calibrate(projectId: string, conversationId: string, agentSurfaceId: "main-agent"): Promise<void>;
  };
  projection: {
    refreshConversation(projectId: string, conversationId: string): Promise<void>;
    routeEvent?(projectId: string, event: WorkbenchLiveEvent): void;
  };
  attachments: {
    upload(projectId: string, upload: ComposerAttachmentUpload): Promise<TopicAttachment>;
    remove(projectId: string, attachmentId: string): Promise<void>;
  };
  drafts: {
    checkpoint(projectId: string, productMode: ProductMode): ComposerDraftCheckpoint;
    flush(projectId: string, productMode: ProductMode): Promise<string | null>;
    settleAccepted(
      accepted: ComposerDraftContent,
      checkpoint: ComposerDraftCheckpoint,
      mutationToken: string | null,
    ): Promise<void>;
  };
  skills: {
    apply(identity: ConversationSubmissionSkillIdentity, overrides: Record<string, boolean>): Promise<void>;
    reload(identity: ConversationSubmissionSkillIdentity): Promise<void>;
  };
  errors: {
    describe(cause: unknown): string;
    classify(cause: unknown, transportStarted: boolean): "failed" | "uncertain";
  };
  onError(message: string | null): void;
}

export function createDraftSubmissionSnapshot(input: Omit<DraftSubmissionSnapshot, "contextRefs" | "attachmentIds" | "skillOverrides"> & {
  contextRefs: readonly TopicFileReference[];
  attachments: readonly Pick<TopicAttachment, "id">[];
  skillOverrides: Readonly<Record<string, boolean>>;
}): DraftSubmissionSnapshot {
  return {
    ...input,
    contextRefs: input.contextRefs.map((reference) => ({ ...reference })),
    attachmentIds: input.attachments.map((attachment) => attachment.id),
    skillOverrides: { ...input.skillOverrides },
  };
}
