import { createHash } from "node:crypto";
import type { AgentCatalog } from "../agent/catalog.js";
import type {
  ProviderCapabilitySnapshot,
  ProviderChildLifecycleEvent,
  ProviderChildThreadResult,
  ProviderModelRef,
} from "../provider-runtime/index.js";
import { agentThreadSurfaceId } from "../provider-runtime/agent-surface-id.js";
import { resolveStoredExecutionContract } from "../provider-runtime/execution-contract.js";
import { resolveRegisteredAgentExecutionProfile } from "./agent-execution-profile-resolver.js";
import type { CanonicalTimelineDelivery } from "./canonical-timeline-delivery.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import type { WorkbenchDatabase } from "./persistence/database.js";
import { childInitialInputMessage } from "./provider-capture-persistence.js";

type ChildTerminalStatus = "completed" | "interrupted" | "failed" | "terminated";

export interface RegisteredProviderChild {
  activityId: string;
  attemptId: string;
  threadId: string;
  parentThreadId: string;
  roleId: string;
  displayName?: string;
  status: "running" | ChildTerminalStatus;
}

export class ProviderChildLifecycleOwner {
  private readonly byActivity = new Map<string, RegisteredProviderChild>();
  private readonly latestByThread = new Map<string, RegisteredProviderChild>();

  constructor(private readonly input: {
    database: WorkbenchDatabase;
    delivery: CanonicalTimelineDelivery;
    catalog: AgentCatalog;
    projectId: string;
    conversationId: string;
    graphScopeId: string;
    changeId: string | null;
    runId: string;
    parentAttemptId: string;
    providerId: string;
    providerAdapterVersion: string;
    capabilitySnapshot: ProviderCapabilitySnapshot;
    model: ProviderModelRef | null;
    parentHandoffHash: string;
    deliveredThroughCompletedTurn: number;
    onInvalidated(): void;
  }) {}

  onLifecycle(event: ProviderChildLifecycleEvent): RegisteredProviderChild | null {
    if (event.providerId !== this.input.providerId) return null;
    if (event.parentSession.providerId !== this.input.providerId || event.childSession.providerId !== this.input.providerId) return null;
    if (event.kind === "closed") return this.close(event);
    const existing = this.byActivity.get(event.activityId);
    if (existing) {
      if (existing.threadId !== event.childSession.sessionId || existing.parentThreadId !== event.parentSession.sessionId) {
        throw new Error(`Provider Child activity ${event.activityId} changed lineage.`);
      }
      if (event.displayName && !existing.displayName) existing.displayName = event.displayName;
      return existing;
    }
    const prior = this.latestByThread.get(event.childSession.sessionId)
      ?? (event.kind === "continued" ? this.readRegisteredChild(event) : null);
    const resolved = resolveRegisteredAgentExecutionProfile(this.input.catalog, event.roleHint ?? prior?.roleId);
    if (!resolved) return null;
    if (prior && (prior.parentThreadId !== event.parentSession.sessionId || prior.roleId !== resolved.catalogEntry.roleId)) {
      throw new Error(`Provider Child ${prior.threadId} continuation changed lineage.`);
    }
    const active = prior;
    if (active?.status === "running") {
      if (active.parentThreadId !== event.parentSession.sessionId || active.roleId !== resolved.catalogEntry.roleId) {
        throw new Error(`Provider Child ${active.threadId} continuation changed lineage.`);
      }
      this.input.database.providerAttempts.assertCurrentRunningAttemptGraph(
        this.input.projectId, this.input.conversationId, this.input.parentAttemptId, this.input.graphScopeId,
      );
      this.input.database.providerAttempts.assertCurrentRunningAttemptGraph(
        this.input.projectId, this.input.conversationId, active.attemptId, this.input.graphScopeId,
      );
      // Guidance to a running Child extends that execution. A new Attempt needs a terminal predecessor.
      this.byActivity.set(event.activityId, active);
      return active;
    }
    const now = new Date().toISOString();
    const attemptId = providerChildActivityAttemptId(
      this.input.parentAttemptId,
      event.childSession.sessionId,
      event.activityId,
    );
    const handoffHash = createHash("sha256").update(JSON.stringify({
      parentHandoffHash: this.input.parentHandoffHash,
      parentAttemptId: this.input.parentAttemptId,
      parentThreadId: event.parentSession.sessionId,
      childThreadId: event.childSession.sessionId,
      activityId: event.activityId,
      turnId: event.turnId ?? null,
      roleId: resolved.catalogEntry.roleId,
    })).digest("hex");
    const record: RegisteredProviderChild = {
      activityId: event.activityId,
      attemptId,
      threadId: event.childSession.sessionId,
      parentThreadId: event.parentSession.sessionId,
      roleId: resolved.catalogEntry.roleId,
      ...(event.displayName ? { displayName: event.displayName } : {}),
      status: "running",
    };
    this.input.database.transaction(() => {
      this.input.database.providerAttempts.assertCurrentRunningAttemptGraph(
        this.input.projectId,
        this.input.conversationId,
        this.input.parentAttemptId,
        this.input.graphScopeId,
      );
      this.input.database.providerAttempts.createProviderAttempt({
        projectId: this.input.projectId,
        conversationId: this.input.conversationId,
        attemptId,
        graphScopeId: this.input.graphScopeId,
        changeId: this.input.changeId,
        agentTaskId: null,
        roleId: record.roleId,
        operationProfile: resolved.operationProfile,
        providerId: this.input.providerId,
        executionContract: resolveStoredExecutionContract({
          productMode: "harness",
          operationProfile: resolved.operationProfile,
          operationKind: "conversation-turn",
          roleId: record.roleId,
          providerAdapterVersion: this.input.providerAdapterVersion,
        }),
        nativeSessionId: record.threadId,
        model: this.input.model,
        capabilitySnapshot: this.input.capabilitySnapshot,
        handoffHash,
        deliveredThroughCompletedTurn: this.input.deliveredThroughCompletedTurn,
        worktreeId: null,
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      this.input.database.providerAttempts.bindProviderAttemptThread(this.input.projectId, {
        attemptId,
        threadId: record.threadId,
        parentThreadId: record.parentThreadId,
        displayName: record.displayName,
        runId: this.input.runId,
      }, now);
    });
    this.byActivity.set(record.activityId, record);
    this.latestByThread.set(record.threadId, record);
    this.input.onInvalidated();
    return record;
  }

  onResult(result: ProviderChildThreadResult): RegisteredProviderChild | null {
    if (result.providerId !== this.input.providerId) return null;
    const child = result.activityId ? this.byActivity.get(result.activityId) : this.latestByThread.get(result.threadId);
    if (!child || child.threadId !== result.threadId || child.parentThreadId !== result.parentThreadId) return null;
    if (child.status !== "running") return child;
    const displayName = result.displayName && child.displayName !== result.displayName
      ? result.displayName
      : null;
    const terminal = childResultStatus(result.status);
    const timelineMessages: ReturnType<typeof toCanonicalTimelineMessage>[] = [];
    if (result.initialInput) {
      const entry = childInitialInputMessage({
        conversationId: this.input.conversationId,
        graphScopeId: this.input.graphScopeId,
        runId: this.input.runId,
        providerId: this.input.providerId,
        attemptId: child.attemptId,
        roleId: child.roleId,
        threadId: child.threadId,
        parentThreadId: child.parentThreadId,
        turnId: result.initialInput.turnId,
        itemId: result.initialInput.itemId,
        text: result.initialInput.text,
      });
      entry.agentSurfaceId = agentThreadSurfaceId(this.input.providerId, child.threadId);
      timelineMessages.push(toCanonicalTimelineMessage(this.input.projectId, this.input.conversationId, entry));
    }
    if (displayName || terminal || timelineMessages.length > 0) {
      const now = new Date().toISOString();
      const rows = this.input.database.unitOfWork.commitProviderCallback({
        projectId: this.input.projectId,
        conversationId: this.input.conversationId,
        attemptId: child.attemptId,
        expectedGraphScopeId: this.input.graphScopeId,
        updatedAt: now,
        ...(terminal ? { terminal: { status: terminal, nativeSessionId: child.threadId } } : {}),
        ...(displayName ? {
          thread: {
            threadId: child.threadId,
            parentThreadId: child.parentThreadId,
            displayName,
            runId: this.input.runId,
          },
        } : {}),
        ...(timelineMessages.length > 0 ? { timelineMessages } : {}),
      });
      this.input.delivery.publishCommittedMany(rows);
      if (displayName) child.displayName = displayName;
      if (terminal) child.status = terminal;
      this.input.onInvalidated();
    }
    return child;
  }

  registeredForThread(threadId: string): RegisteredProviderChild | null {
    return this.latestByThread.get(threadId) ?? null;
  }

  registeredChildren(): RegisteredProviderChild[] {
    return [...this.latestByThread.values()];
  }

  terminalAttempts(fallback: "failed" | "interrupted"): Array<{
    attemptId: string;
    status: ChildTerminalStatus;
    nativeSessionId: string;
  }> {
    const children = [...new Map([...this.byActivity.values()].map((child) => [child.attemptId, child])).values()];
    return children.map((child) => ({
      attemptId: child.attemptId,
      status: child.status === "running" ? fallback : child.status,
      nativeSessionId: child.threadId,
    }));
  }

  private close(event: ProviderChildLifecycleEvent): RegisteredProviderChild | null {
    const child = this.latestByThread.get(event.childSession.sessionId) ?? this.readRegisteredChild(event);
    if (!child) return null;
    if (child.parentThreadId !== event.parentSession.sessionId) {
      throw new Error(`Provider Child ${child.threadId} close changed parent lineage.`);
    }
    this.complete(child, "terminated");
    return child;
  }

  private readRegisteredChild(event: ProviderChildLifecycleEvent): RegisteredProviderChild | null {
    const link = this.input.database.providerAttempts.listProviderThreads(this.input.projectId, this.input.conversationId)
      .find((candidate) => candidate.providerId === this.input.providerId
        && candidate.providerThreadId === event.childSession.sessionId
        && candidate.parentThreadId === event.parentSession.sessionId
        && candidate.graphScopeId === this.input.graphScopeId
        && candidate.roleId !== "main-agent");
    if (!link) return null;
    const attempt = this.input.database.providerAttempts.readProviderAttempt(this.input.projectId, link.attemptId);
    const profile = resolveRegisteredAgentExecutionProfile(this.input.catalog, link.roleId);
    if (!attempt
      || !profile
      || attempt.conversationId !== this.input.conversationId
      || attempt.roleId !== link.roleId
      || attempt.operationProfile !== profile.operationProfile
      || attempt.providerId !== link.providerId
      || attempt.nativeSessionId !== link.providerThreadId
      || attempt.graphScopeId !== link.graphScopeId) return null;
    const child: RegisteredProviderChild = {
      activityId: event.activityId,
      attemptId: attempt.attemptId,
      threadId: link.providerThreadId,
      parentThreadId: link.parentThreadId!,
      roleId: link.roleId,
      ...(link.displayName ? { displayName: link.displayName } : {}),
      status: attempt.status === "queued" || attempt.status === "running"
        ? "running"
        : attempt.status === "blocked" ? "failed" : attempt.status,
    };
    this.byActivity.set(event.activityId, child);
    this.latestByThread.set(child.threadId, child);
    return child;
  }

  private complete(child: RegisteredProviderChild, status: ChildTerminalStatus): void {
    if (child.status === "terminated") return;
    if (status !== "terminated" && child.status !== "running") return;
    this.input.database.unitOfWork.commitProviderCallback({
      projectId: this.input.projectId,
      conversationId: this.input.conversationId,
      attemptId: child.attemptId,
      expectedGraphScopeId: this.input.graphScopeId,
      updatedAt: new Date().toISOString(),
      terminal: { status, nativeSessionId: child.threadId },
    });
    child.status = status;
    this.input.onInvalidated();
  }
}

export function providerChildActivityAttemptId(parentAttemptId: string, childThreadId: string, activityId: string): string {
  const activityHash = createHash("sha256").update(activityId).digest("hex").slice(0, 12);
  return `${parentAttemptId}:child:${childThreadId}:${activityHash}`;
}

function childResultStatus(status: string | undefined): Exclude<ChildTerminalStatus, "terminated"> | null {
  if (status === "completed" || status === "failed" || status === "interrupted") return status;
  return null;
}
