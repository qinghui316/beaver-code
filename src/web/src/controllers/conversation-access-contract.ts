export type AgentAccessMode = "default" | "full-access";

export interface ConversationAccessIdentity {
  projectId: string;
  conversationId: string | null;
  providerId: string;
}

export interface ConversationAccessSelection {
  accessMode: AgentAccessMode;
  revision: number;
  providerId: string;
}

export interface ConversationAccessApi {
  read(identity: ConversationAccessIdentity): Promise<ConversationAccessSelection>;
  save(identity: ConversationAccessIdentity, selection: ConversationAccessSelection, accessMode: AgentAccessMode,
    confirmFullAccess: boolean): Promise<ConversationAccessSelection>;
}

export interface ConversationAccessCapturePort {
  capture(): { agentAccessMode?: AgentAccessMode; expectedAccessRevision?: number }
    | Promise<{ agentAccessMode?: AgentAccessMode; expectedAccessRevision?: number }>;
}

export interface ConversationAccessView {
  scopeKey: string;
  visible: boolean;
  mode: AgentAccessMode;
  busy: boolean;
  fullAccessAvailable: boolean;
  failure: string | null;
}
