import { createHash } from "node:crypto";
import type { ProductMode, ProviderId } from "../provider-runtime/index.js";
import type { ActiveProviderTurn, ProviderTurnStartedIdentity } from "../provider-runtime/contracts.js";
import type { ProviderRegistry } from "../provider-runtime/registry.js";
import type { ProjectRuntimeCoordinatorPort } from "../project-runtime/coordinator.js";
import type { ManagedProject } from "../types/index.js";
import type { StoredProviderAttempt } from "./persistence/contracts.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import { publishConversationTurnControlInvalidated } from "./project-live-events.js";

const MAX_STEER_CLIENT_REQUEST_ID_LENGTH = 200;

export interface ConversationTurnInterruptRequest {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  providerId: ProviderId;
  expectedAttemptId: string;
}

export interface ConversationTurnSteerRequest extends ConversationTurnInterruptRequest {
  clientRequestId: string;
  text: string;
}

export type ConversationTurnInterruptReceipt =
  | { status: "pending" | "interrupt-requested"; attemptId: string; runId: string }
  | { status: "already-terminal"; attemptId: string; runId?: string };

export type ConversationTurnSteerReceipt =
  | { status: "steer-accepted"; attemptId: string; runId: string }
  | { status: "already-terminal"; attemptId: string; runId?: string };

export function conversationSteerTimelineIds(attemptId: string, clientRequestId: string): {
  userId: string;
  ackId: string;
} {
  return {
    userId: `steer:${attemptId}:${clientRequestId}:user`,
    ackId: `steer:${attemptId}:${clientRequestId}:ack`,
  };
}

export interface ConversationTurnControlState {
  state: "idle" | "running" | "stopping";
  canInterrupt: boolean;
  canSteer: boolean;
  steerState: "idle" | "submitting";
  providerId?: ProviderId;
  attemptId?: string;
  runId?: string;
}

export interface ConversationTurnRegistration extends ConversationTurnInterruptRequest {
  graphScopeId: string;
  runId: string;
  roleId: "main-agent";
  canSteer: boolean;
  onInputAccepted?: (clientRequestId: string, userMessageId: string) => void;
}

type SteerEntry = {
  textHash: string;
  phase: "submitting" | "accepted";
  receipt: ConversationTurnSteerReceipt | null;
  submission: Promise<ConversationTurnSteerReceipt> | null;
};

type ControlEntry = {
  registration: ConversationTurnRegistration;
  started: ProviderTurnStartedIdentity | null;
  interruptPhase: "running" | "pending" | "submitting";
  interruptSubmission: Promise<ConversationTurnInterruptReceipt> | null;
  interruptReason: string | null;
  steers: Map<string, SteerEntry>;
};

export class ConversationTurnControlOwner {
  private readonly entries = new Map<string, ControlEntry>();
  private readonly drainWaiters = new Set<() => void>();
  private readonly admissionObservers = new Set<() => void>();

  subscribeAdmission(observer: () => void): () => void {
    this.admissionObservers.add(observer);
    return () => { this.admissionObservers.delete(observer); };
  }

  constructor(private readonly options: {
    providerRegistry: ProviderRegistry;
    projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve">;
    onInvalidated?: (projectId: string, data: { conversationId: string; attemptId: string }) => void;
  }) {}

  registerAttempt(registration: ConversationTurnRegistration): void {
    const key = controlKey(registration.projectId, registration.conversationId);
    const current = this.entries.get(key);
    if (current && !sameRegistration(current.registration, registration)) {
      throw conflict("Conversation Turn control is already registered with different Turn identity.");
    }
    this.entries.set(key, current ?? {
      registration: { ...registration },
      started: null,
      interruptPhase: "running",
      interruptSubmission: null,
      interruptReason: null,
      steers: new Map(),
    });
    this.invalidate(registration);
    for (const observer of this.admissionObservers) {
      try { observer(); } catch { /* Transport observation never changes execution authority. */ }
    }
  }

  onTurnStarted = (identity: ProviderTurnStartedIdentity): void => {
    if (!identity.conversationId) return;
    const entry = this.entries.get(controlKey(identity.projectId, identity.conversationId));
    if (!entry || !sameStartedIdentity(entry.registration, identity)) return;
    entry.started = { ...identity };
    if (entry.interruptPhase === "pending") void this.submitInterrupt(entry, undefined, entry.interruptReason ?? undefined).catch(() => undefined);
    else this.invalidate(entry.registration);
  };

  release(registration: ConversationTurnRegistration): void {
    const key = controlKey(registration.projectId, registration.conversationId);
    const current = this.entries.get(key);
    if (!current || current.registration.expectedAttemptId !== registration.expectedAttemptId) return;
    this.entries.delete(key);
    if (this.entries.size === 0) {
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    }
    this.invalidate(registration);
  }

  async interruptAll(reason: string): Promise<void> {
    const submissions = [...this.entries.values()].map((entry) => {
      entry.interruptReason = reason;
      return this.submitInterrupt(entry, undefined, reason);
    });
    const results = await Promise.allSettled(submissions);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more Conversation Turns rejected interruption.");
    }
  }

  async drain(): Promise<void> {
    if (this.entries.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  state(projectId: string, conversationId: string, expectedAttemptId?: string): ConversationTurnControlState {
    const entry = this.entries.get(controlKey(projectId, conversationId));
    if (!entry || (expectedAttemptId && entry.registration.expectedAttemptId !== expectedAttemptId)) {
      return { state: "idle", canInterrupt: false, canSteer: false, steerState: "idle" };
    }
    const steerState = [...entry.steers.values()].some((steer) => steer.phase === "submitting")
      ? "submitting"
      : "idle";
    const stopping = entry.interruptPhase !== "running";
    return {
      state: stopping ? "stopping" : "running",
      canInterrupt: true,
      canSteer: !stopping
        && steerState === "idle"
        && entry.registration.canSteer
        && Boolean(entry.started)
        && this.hasExactActiveTurn(entry.registration),
      steerState,
      providerId: entry.registration.providerId,
      attemptId: entry.registration.expectedAttemptId,
      runId: entry.registration.runId,
    };
  }

  async interrupt(project: ManagedProject, request: ConversationTurnInterruptRequest): Promise<ConversationTurnInterruptReceipt> {
    const { attempt, entry, runId } = await this.validateCurrentTurn(project, request);
    if (attempt.status !== "queued" && attempt.status !== "running") {
      return { status: "already-terminal", attemptId: attempt.attemptId, ...(runId ? { runId } : {}) };
    }
    if (!entry || !sameRequest(entry.registration, request)) {
      throw conflict("The requested Attempt is not owned by a current-process Provider Turn.");
    }
    if (attempt.nativeSessionId && entry.started && attempt.nativeSessionId !== entry.started.sessionId) {
      throw conflict("The durable Provider Session does not match the started Turn identity.");
    }
    if (entry.interruptPhase === "pending") {
      return { status: "pending", attemptId: request.expectedAttemptId, runId: entry.registration.runId };
    }
    if (entry.interruptSubmission) return entry.interruptSubmission;
    const active = this.exactActiveTurn(entry.registration);
    if (!active) {
      entry.interruptPhase = "pending";
      this.invalidate(entry.registration);
      return { status: "pending", attemptId: request.expectedAttemptId, runId: entry.registration.runId };
    }
    return this.submitInterrupt(entry, active, "User requested interrupt from the owning Conversation.");
  }

  async steer(project: ManagedProject, request: ConversationTurnSteerRequest, onAccepted?: (receipt: Extract<ConversationTurnSteerReceipt, { status: "steer-accepted" }>) => void): Promise<ConversationTurnSteerReceipt> {
    let invoked = false;
    try {
    const text = request.text.trim();
    const clientRequestId = request.clientRequestId.trim();
    if (!clientRequestId || clientRequestId.length > MAX_STEER_CLIENT_REQUEST_ID_LENGTH || !text) {
      throw badRequest("Conversation steering requires text and a clientRequestId of at most 200 characters.");
    }
    const normalized = { ...request, clientRequestId, text };
    const { attempt, entry, runId } = await this.validateCurrentTurn(project, normalized);
    if (attempt.status !== "queued" && attempt.status !== "running") {
      return { status: "already-terminal", attemptId: attempt.attemptId, ...(runId ? { runId } : {}) };
    }
    if (!entry || !sameRequest(entry.registration, normalized)) {
      throw conflict("The requested Attempt is not owned by a current-process Provider Turn.");
    }
    if (attempt.nativeSessionId && entry.started && attempt.nativeSessionId !== entry.started.sessionId) {
      throw conflict("The durable Provider Session does not match the started Turn identity.");
    }
    if (!entry.registration.canSteer) throw conflict("The current Provider Turn does not support realtime steering.");
    if (entry.interruptPhase !== "running") throw conflict("The current Provider Turn is stopping and cannot be steered.");

    const textHash = createHash("sha256").update(text, "utf8").digest("hex");
    const existing = entry.steers.get(normalized.clientRequestId);
    if (existing) {
      if (existing.textHash !== textHash) throw conflict("The steering request id is already bound to different text.");
      if (existing.receipt) return existing.receipt;
      if (existing.submission) return existing.submission;
    }
    if ([...entry.steers.values()].some((candidate) => candidate.phase === "submitting")) {
      throw conflict("A steering submission is still awaiting a definite Provider outcome.");
    }

    const active = this.exactActiveTurn(entry.registration);
    if (!active) throw conflict("The requested Attempt is not backed by an active Provider Turn.");
    const steer: SteerEntry = existing ?? { textHash, phase: "submitting", receipt: null, submission: null };
    entry.steers.set(normalized.clientRequestId, steer);
    invoked = true;
    return this.submitSteer(entry, normalized.clientRequestId, steer, active, text, onAccepted);
    } catch (cause) {
      if (!invoked && cause instanceof Error) Object.assign(cause, { inputNotInvoked: true });
      throw cause;
    }
  }

  async settlePendingInputs(registration: ConversationTurnRegistration): Promise<void> {
    const entry = this.entries.get(controlKey(registration.projectId, registration.conversationId));
    if (!entry || !sameRegistration(entry.registration, registration)) return;
    await Promise.allSettled([...entry.steers.values()].flatMap((steer) => steer.submission ? [steer.submission] : []));
  }

  async waitForTerminal(project: ManagedProject, request: ConversationTurnInterruptRequest): Promise<void> {
    // Interrupt acknowledgement is transport evidence. Only the persisted
    // Attempt terminal (including its commit) authorizes a subsequent turn.
    for (;;) {
      const { attempt } = await this.validateCurrentTurn(project, request);
      if (attempt.status !== "queued" && attempt.status !== "running") return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  private async validateCurrentTurn(
    project: ManagedProject,
    request: ConversationTurnInterruptRequest,
  ): Promise<{
    attempt: StoredProviderAttempt;
    entry: ControlEntry | null;
    runId: string | undefined;
  }> {
    if (project.id !== request.projectId) throw conflict("Turn control project identity does not match the selected project.");
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths, { providerRegistry: this.options.providerRegistry });
    try {
      const conversation = database.conversations.readConversation(paths.projectId, request.conversationId);
      const attempt = database.providerAttempts.readProviderAttempt(paths.projectId, request.expectedAttemptId);
      if (!conversation || conversation.deletedAt) throw notFound("Conversation not found.");
      if (!attempt
        || conversation.productMode !== request.productMode
        || conversation.selectedProviderId !== request.providerId
        || attempt.projectId !== paths.projectId
        || attempt.conversationId !== conversation.conversationId
        || attempt.productMode !== request.productMode
        || attempt.providerId !== request.providerId
        || attempt.roleId !== "main-agent"
        || attempt.graphScopeId !== conversation.currentGraphScopeId) {
        throw conflict("Turn control request does not match the current Conversation and main Attempt.");
      }
      const entry = this.entries.get(controlKey(paths.projectId, conversation.conversationId)) ?? null;
      const durableLink = database.providerAttempts
        .listProviderThreads(paths.projectId, conversation.conversationId)
        .find((candidate) => candidate.attemptId === attempt.attemptId
          && candidate.providerId === attempt.providerId
          && candidate.roleId === "main-agent"
          && candidate.graphScopeId === attempt.graphScopeId);
      return {
        attempt,
        entry,
        runId: durableLink?.runId ?? (entry && sameRequest(entry.registration, request) ? entry.registration.runId : undefined),
      };
    } finally {
      database.close();
    }
  }

  private submitInterrupt(entry: ControlEntry, knownActive?: ActiveProviderTurn, reason?: string): Promise<ConversationTurnInterruptReceipt> {
    if (entry.interruptSubmission) return entry.interruptSubmission;
    const active = knownActive ?? this.exactActiveTurn(entry.registration);
    if (!active) {
      entry.interruptPhase = "pending";
      entry.interruptReason = reason ?? entry.interruptReason;
      this.invalidate(entry.registration);
      return Promise.resolve({
        status: "pending",
        attemptId: entry.registration.expectedAttemptId,
        runId: entry.registration.runId,
      });
    }
    entry.interruptPhase = "submitting";
    entry.interruptReason = reason ?? entry.interruptReason;
    this.invalidate(entry.registration);
    entry.interruptSubmission = active.interrupt(entry.interruptReason ?? "User requested interrupt from the owning Conversation.")
      .then((result) => result.status === "already-terminal"
        ? {
          status: "already-terminal" as const,
          attemptId: entry.registration.expectedAttemptId,
          runId: entry.registration.runId,
        }
        : {
          status: "interrupt-requested" as const,
          attemptId: entry.registration.expectedAttemptId,
          runId: entry.registration.runId,
        })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "ProviderInterruptRejected") {
          entry.interruptPhase = "running";
          entry.interruptSubmission = null;
          entry.interruptReason = null;
          this.invalidate(entry.registration);
        }
        throw error;
      });
    return entry.interruptSubmission;
  }

  private submitSteer(
    entry: ControlEntry,
    clientRequestId: string,
    steer: SteerEntry,
    active: ActiveProviderTurn,
    text: string,
    onAccepted?: (receipt: Extract<ConversationTurnSteerReceipt, { status: "steer-accepted" }>) => void,
  ): Promise<ConversationTurnSteerReceipt> {
    if (steer.submission) return steer.submission;
    steer.phase = "submitting";
    this.invalidate(entry.registration);
    steer.submission = active.steer(text)
      .then(() => {
        const receipt = {
          status: "steer-accepted" as const,
          attemptId: entry.registration.expectedAttemptId,
          runId: entry.registration.runId,
        };
        steer.phase = "accepted";
        steer.receipt = receipt;
        steer.submission = null;
        onAccepted?.(receipt);
        entry.registration.onInputAccepted?.(clientRequestId, conversationSteerTimelineIds(receipt.attemptId, clientRequestId).userId);
        this.invalidate(entry.registration);
        return receipt;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "ProviderSteerRejected") {
          Object.assign(error, { inputNotInvoked: true });
          entry.steers.delete(clientRequestId);
          this.invalidate(entry.registration);
        }
        throw error;
      });
    return steer.submission;
  }

  private exactActiveTurn(registration: ConversationTurnRegistration): ActiveProviderTurn | null {
    const entry = this.entries.get(controlKey(registration.projectId, registration.conversationId));
    const started = entry?.started;
    if (!started) return null;
    const active = this.options.providerRegistry.findActiveTurn(registration.conversationId);
    if (!active) return null;
    if (active.providerId !== registration.providerId
      || active.runtimeScopeId !== registration.conversationId
      || active.attemptId !== registration.expectedAttemptId
      || active.runId !== registration.runId
      || active.roleId !== registration.roleId
      || active.session.sessionId !== started.sessionId
      || active.turnId !== started.turnId) {
      throw conflict("Active Provider Turn does not match the registered Conversation Attempt.");
    }
    return active;
  }

  private hasExactActiveTurn(registration: ConversationTurnRegistration): boolean {
    try {
      return Boolean(this.exactActiveTurn(registration));
    } catch {
      return false;
    }
  }

  private invalidate(registration: ConversationTurnRegistration): void {
    (this.options.onInvalidated ?? publishConversationTurnControlInvalidated)(registration.projectId, {
      conversationId: registration.conversationId,
      attemptId: registration.expectedAttemptId,
    });
  }
}

function sameRequest(registration: ConversationTurnRegistration, request: ConversationTurnInterruptRequest): boolean {
  return registration.projectId === request.projectId
    && registration.productMode === request.productMode
    && registration.conversationId === request.conversationId
    && registration.providerId === request.providerId
    && registration.expectedAttemptId === request.expectedAttemptId;
}

function sameRegistration(left: ConversationTurnRegistration, right: ConversationTurnRegistration): boolean {
  return sameRequest(left, right)
    && left.graphScopeId === right.graphScopeId
    && left.runId === right.runId
    && left.roleId === right.roleId
    && Boolean(left.canSteer) === Boolean(right.canSteer);
}

function sameStartedIdentity(registration: ConversationTurnRegistration, identity: ProviderTurnStartedIdentity): boolean {
  return registration.projectId === identity.projectId
    && registration.conversationId === identity.conversationId
    && registration.providerId === identity.providerId
    && registration.expectedAttemptId === identity.attemptId
    && registration.runId === identity.runId
    && registration.roleId === identity.roleId
    && identity.runtimeScopeId === registration.conversationId;
}

function controlKey(projectId: string, conversationId: string): string {
  return `${projectId}\0${conversationId}`;
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFound";
  return error;
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}
