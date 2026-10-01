import type { AgentTask } from "../types/index.js";
import type { AgentTaskStorePort } from "./paths.js";
import { recordMainAgentDecision } from "./decisions.js";
import { claimAgentTask, completeAgentTask, createAgentTask, heartbeatAgentTask, startAgentTask, type CompleteAgentTaskInput } from "./repository.js";
import { buildDelegateTaskDecisionInput, type AgentTaskRequest, validateDelegateTaskPolicy } from "./delegate-task.js";
import { recordToolEventAuditEntry } from "./boundary-audit.js";
import { evaluateToolPolicy } from "./tool-policy.js";

export interface RoleDispatchResult {
  task: AgentTask;
  policyAuditRef: string;
}

/** Keep the captured foreground writer alive until its result has been committed. */
export async function withForegroundRoleTaskLease<T>(
  memory: AgentTaskStorePort,
  task: AgentTask,
  operation: (settle: (input: Omit<CompleteAgentTaskInput, "writer">) => ReturnType<typeof completeAgentTask>) => Promise<T>,
): Promise<T> {
  if (task.kind !== "foreground" || !task.lease) throw new Error("Foreground role execution requires a claimed lease.");
  const writer = { claimToken: task.lease.claimToken, fencingToken: task.lease.fencingToken };
  const duration = Date.parse(task.lease.expiresAt) - Date.parse(task.lease.heartbeatAt);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Foreground role lease duration is invalid.");
  let current = await heartbeatAgentTask(memory, task, writer, duration);
  let stopped = false;
  let renewalFailure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const schedule = () => {
    if (stopped || renewalFailure) return;
    timer = setTimeout(() => {
      pending = heartbeatAgentTask(memory, current, writer, duration)
        .then((renewed) => { current = renewed; })
        .catch((cause: unknown) => { renewalFailure = cause instanceof Error ? cause : new Error(String(cause)); })
        .then(schedule);
    }, Math.max(1, Math.min(10_000, Math.floor(duration / 3))));
    timer.unref();
  };
  const stop = async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
  schedule();
  try {
    const result = await operation(async (input) => {
      await stop();
      if (renewalFailure) throw renewalFailure;
      return completeAgentTask(memory, current, { ...input, writer });
    });
    await stop();
    if (renewalFailure) throw renewalFailure;
    return result;
  } finally {
    await stop();
  }
}

export async function dispatchForegroundRoleTask(memory: AgentTaskStorePort, request: AgentTaskRequest): Promise<RoleDispatchResult> {
  const policy = await validateDelegateTaskPolicy(memory, request);
  const toolDecision = evaluateToolPolicy({
    actionType: "delegateTask",
    actorRoleId: "main-agent",
    changeId: request.changeId,
    conversationId: request.conversationId,
    targetId: request.roleId,
    goal: request.goal,
    enforcementMode: "broker-enforced",
  });
  const policyAuditRef = await recordToolEventAuditEntry(memory, {
    changeId: request.changeId,
    conversationId: request.conversationId,
    actorRoleId: "main-agent",
    actionType: "delegateTask",
    targetId: request.roleId,
    decision: policy.ok ? toolDecision : { ...toolDecision, status: "denied", reason: policy.reason, readableMessage: policy.readableMessage },
  });
  if (!policy.ok) throw new Error(policy.readableMessage);
  if (toolDecision.status === "denied" || toolDecision.status === "unavailable") throw new Error(toolDecision.readableMessage);

  await recordMainAgentDecision(memory, buildDelegateTaskDecisionInput(policy.request, policy.reason));
  const queued = await createAgentTask(memory, {
    conversationId: policy.request.conversationId,
    changeId: policy.request.changeId,
    roleId: policy.request.roleId,
    kind: "foreground",
    summary: policy.request.goal,
    inputArtifacts: policy.request.inputArtifacts ?? [],
    parentTaskId: policy.request.parentTaskId,
    createdBy: "main-agent-policy",
    initialStatus: "queued",
  });
  const claimed = await claimAgentTask(memory, queued);
  return { task: await startAgentTask(memory, claimed), policyAuditRef };
}
