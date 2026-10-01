import { startAuditRun } from "../audit/manager.js";
import { recordPostRunBoundaryAudit, boundaryAuditArtifactRef } from "../agent-task/boundary-audit.js";
import { dispatchForegroundRoleTask, withForegroundRoleTaskLease } from "../agent-task/role-dispatcher.js";
import {
  recordWorkflowRuntimeExecutionStep,
  type WorkflowRuntimeDecision,
  type WorkflowRuntimeExecutionState,
  type WorkflowRuntimeRole,
} from "./execution-contract.js";
import type { AgentTaskRequest } from "../agent-task/delegate-task.js";
import { startCodeRun, type CodeExecutionGateOptions } from "../code/manager.js";
import type { AgentTask, ManagedProject } from "../types/index.js";
import { startValidationRun } from "../validation/manager.js";
import { compactArtifactRefs } from "./kernel/runtime-guards.js";
import type { AgentTaskStorePort } from "../agent-task/paths.js";
import type { ProjectRunsPathPort } from "../project-runtime/paths.js";
import {
  emitAssistantEvent,
  emitAuditAssistantEvent,
  emitDelegatedRoleReturn,
  emitValidationAssistantEvents,
  forwardProviderStreamEvent,
  type WorkflowRuntimeLiveSink,
} from "./kernel/live-events.js";

export type CodeLeafRun = Awaited<ReturnType<typeof startCodeRun>>;
export type ValidationLeafRun = Awaited<ReturnType<typeof startValidationRun>>;
export type AuditLeafRun = Awaited<ReturnType<typeof startAuditRun>>;

export type WorkflowRuntimeLeafStoppedAt = "boundary" | "code" | "validation" | "audit";

export type WorkflowRoleRuntimePort = ProjectRunsPathPort & AgentTaskStorePort;

export interface WorkflowLeafExecutionServices {
  startCode: typeof startCodeRun;
  startValidation: typeof startValidationRun;
  startAudit: typeof startAuditRun;
}

const defaultLeafServices: WorkflowLeafExecutionServices = {
  startCode: startCodeRun,
  startValidation: startValidationRun,
  startAudit: startAuditRun,
};

export interface WorkflowRuntimeCoderLeafResult {
  leaf: "coder";
  roleId: "coder-agent" | "rework-coder";
  status: "completed" | "interrupted" | "failed";
  stoppedAt?: WorkflowRuntimeLeafStoppedAt;
  code?: CodeLeafRun;
  boundaryAudit?: Awaited<ReturnType<typeof recordPostRunBoundaryAudit>>;
  error?: string;
  orchestration: WorkflowRuntimeExecutionState;
}

export interface WorkflowRuntimeValidatorLeafResult {
  leaf: "validator";
  roleId: "validator";
  status: "completed" | "failed";
  stoppedAt?: "validation";
  validation?: ValidationLeafRun;
  error?: string;
  orchestration: WorkflowRuntimeExecutionState;
}

export interface WorkflowRuntimeAuditorLeafResult {
  leaf: "auditor";
  roleId: "auditor-agent";
  status: "completed" | "failed";
  stoppedAt?: "audit";
  audit?: AuditLeafRun;
  error?: string;
  orchestration: WorkflowRuntimeExecutionState;
}

async function createDelegatedForegroundTask(
  memory: WorkflowRoleRuntimePort,
  request: AgentTaskRequest,
  live: WorkflowRuntimeLiveSink | undefined,
): Promise<{ task: AgentTask; policyAuditRef: string }> {
  const result = await dispatchForegroundRoleTask(memory, { ...request, delegationMode: request.delegationMode ?? "orchestrator-policy" });
  emitAssistantEvent(live, {
    runId: request.changeId,
    kind: "status",
    phase: "delegateTask.accepted",
    title: `调用 ${request.roleId}`,
    summary: "主 agent 已通过 ToolPolicyGate 和 RoleDispatcher 边界创建角色任务。",
    artifactRef: result.policyAuditRef,
  });
  emitAssistantEvent(live, {
    runId: request.changeId,
    kind: "status",
    phase: "delegateTask.running",
    title: `${request.roleId} 开始处理`,
    summary: "角色任务已进入 queued/claimed/running 生命周期。",
    artifactRef: result.policyAuditRef,
  });
  return result;
}

export async function runCoderLeafStage(input: {
  project: ManagedProject;
  memory: WorkflowRoleRuntimePort;
  changeId: string;
  prompt?: string;
  live?: WorkflowRuntimeLiveSink;
  taskIds?: string[];
  taskRunId?: string;
  roleId: "coder-agent" | "rework-coder";
  orchestration: WorkflowRuntimeExecutionState;
  decision?: Extract<WorkflowRuntimeDecision, { kind: "delegate-role" }>;
  executionGate?: CodeExecutionGateOptions;
  existingWorktreeId?: string;
  services?: WorkflowLeafExecutionServices;
}): Promise<WorkflowRuntimeCoderLeafResult> {
  const coderInputArtifacts = input.decision?.inputArtifacts.length ? input.decision.inputArtifacts : input.taskRunId ? [input.taskRunId] : [];
  const coderDispatch = await createDelegatedForegroundTask(input.memory, {
    conversationId: input.changeId,
    changeId: input.changeId,
    roleId: input.roleId,
    kind: "foreground",
    goal: input.decision?.goal ?? (input.roleId === "rework-coder" ? "Repair implementation from validation or audit evidence." : "Implement the confirmed demand in an AHO-owned worktree."),
    inputArtifacts: coderInputArtifacts,
    delegationMode: "orchestrator-policy",
  }, input.live);
  const coderTask = coderDispatch.task;
  return withForegroundRoleTaskLease<WorkflowRuntimeCoderLeafResult>(input.memory, coderTask, async (settle) => {
    input.live?.emit({ event: "run.status", data: { status: "running", label: "Coder" } });
    let coderStartedEmitted = false;
    let code: CodeLeafRun;
    let orchestration = input.orchestration;
    try {
      code = await (input.services ?? defaultLeafServices).startCode(input.project, {
        changeId: input.changeId,
        roleId: input.roleId,
        prompt: input.prompt,
        taskIds: input.taskIds,
        taskRunId: input.taskRunId,
        executionGate: input.executionGate,
        existingWorktreeId: input.existingWorktreeId,
        live: {
          onRunStarted: (run) => {
            coderStartedEmitted = true;
            input.live?.emit({ event: "run.started", data: { runId: run.id, changeId: run.changeId, runtime: run.runtime, actionType: "code.run", taskIds: run.taskIds } });
          },
          onStatus: (event) => input.live?.emit({ event: "run.status", data: event }),
          onProviderEvent: (event) => forwardProviderStreamEvent(event.runId, event, input.live),
          onCallbackError: (event) => input.live?.emit({ event: "error", data: { runId: event.runId, message: event.error instanceof Error ? event.error.message : String(event.error) } }),
        },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
        roleId: workflowRuntimeCoderRole(input.roleId),
        status: "failed",
        inputArtifacts: coderInputArtifacts,
        outputArtifacts: [],
        failureClassification: "code-failure",
        stoppedAt: "code",
        summary: "Coder failed before code run artifacts were created.",
      });
      await settle({
        status: "failed",
        summary: "Coder failed before code run artifacts were created.",
        artifactRefs: [],
        policyAuditRefs: [coderDispatch.policyAuditRef],
        failureClassification: "code-failure",
        requiresUserInputReason: message,
      });
      emitDelegatedRoleReturn(input.live, input.changeId, input.roleId, "failed", "coder-agent 在创建 code run 前失败，任务已关闭为 failed。", coderDispatch.policyAuditRef);
      return { leaf: "coder", roleId: input.roleId, status: "failed", error: message, stoppedAt: "code", orchestration };
    }

    if (!coderStartedEmitted) {
      input.live?.emit({ event: "run.started", data: { runId: code.run.id, changeId: code.run.changeId, runtime: code.run.runtime, actionType: "code.run", taskIds: code.run.taskIds } });
    }
    input.live?.emit({ event: "run.status", data: { runId: code.run.id, status: code.run.status, label: "Coder" } });
    const coderBoundaryAudit = await recordPostRunBoundaryAudit(input.memory, {
      changeId: input.changeId,
      roleId: input.roleId,
      runId: code.run.id,
      taskId: coderTask.id,
      sourceChanged: code.warnings.some((warning) => warning.toLowerCase().includes("source project git status changed")),
      artifactRefs: compactArtifactRefs(code.run.artifacts.directory, code.run.artifacts.implementation),
    });
    const coderBoundaryRef = boundaryAuditArtifactRef(input.memory, coderBoundaryAudit);
    emitAssistantEvent(input.live, {
      runId: code.run.id,
      kind: "tool-result",
      phase: "boundary-audit",
      title: coderBoundaryAudit.status === "passed" ? "边界审计通过" : "边界审计发现越界",
      summary: coderBoundaryAudit.status === "passed" ? "coder-agent 的输出未越过本次需求的运行边界。" : coderBoundaryAudit.violations.map((violation) => violation.reason).join("\n"),
      artifactRef: coderBoundaryRef,
      isError: coderBoundaryAudit.status === "failed",
    });

    if (coderBoundaryAudit.status === "failed") {
      const coderOutputArtifacts = compactArtifactRefs(code.run.artifacts.directory, code.run.artifacts.implementation, coderBoundaryRef);
      orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
        roleId: workflowRuntimeCoderRole(input.roleId),
        status: "failed",
        inputArtifacts: coderInputArtifacts,
        outputArtifacts: coderOutputArtifacts,
        failureClassification: "boundary-violation",
        stoppedAt: "boundary",
        summary: "Coder run failed boundary audit.",
      });
      await settle({
        status: "failed",
        summary: "Coder run failed boundary audit.",
        artifactRefs: [code.run.artifacts.directory],
        policyAuditRefs: [coderDispatch.policyAuditRef],
        boundaryAuditRefs: [coderBoundaryRef],
        boundaryViolations: coderBoundaryAudit.violations,
        failureClassification: "boundary-violation",
        requiresUserInputReason: "Coder modified outside its allowed boundary.",
      });
      emitDelegatedRoleReturn(input.live, input.changeId, input.roleId, "failed", "coder-agent 越过了允许边界，结果不会进入应用流程。", coderBoundaryRef);
      return { leaf: "coder", roleId: input.roleId, status: "failed", code, stoppedAt: "boundary", boundaryAudit: coderBoundaryAudit, orchestration };
    }

    if (code.run.status === "interrupted" && code.run.worktree?.worktreeId) {
      const coderOutputArtifacts = compactArtifactRefs(code.run.artifacts.directory, code.run.artifacts.implementation);
      orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
        roleId: workflowRuntimeCoderRole(input.roleId),
        status: "failed",
        inputArtifacts: coderInputArtifacts,
        outputArtifacts: coderOutputArtifacts,
        failureClassification: "code-failure",
        stoppedAt: "code",
        summary: "Coder was interrupted; its worktree is preserved for provider-neutral resume.",
      });
      await settle({
        status: "cancelled",
        summary: "Coder was interrupted; its worktree is preserved for resume.",
        artifactRefs: coderOutputArtifacts,
        policyAuditRefs: [coderDispatch.policyAuditRef],
        boundaryAuditRefs: [coderBoundaryRef],
        nextRecommendation: "Resume the same TaskRun in its existing worktree.",
      });
      emitDelegatedRoleReturn(input.live, input.changeId, input.roleId, "failed", "coder-agent 已中断，当前 worktree 已保留等待继续。", code.run.artifacts.directory);
      return { leaf: "coder", roleId: input.roleId, status: "interrupted", code, stoppedAt: "code", orchestration };
    }

    if (code.run.status !== "completed" || !code.run.worktree?.worktreeId) {
      const coderOutputArtifacts = compactArtifactRefs(code.run.artifacts.directory, code.run.artifacts.implementation);
      orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
        roleId: workflowRuntimeCoderRole(input.roleId),
        status: "failed",
        inputArtifacts: coderInputArtifacts,
        outputArtifacts: coderOutputArtifacts,
        failureClassification: "code-failure",
        stoppedAt: "code",
        summary: "Coder did not produce a completed worktree proposal.",
      });
      await settle({
        status: "failed",
        summary: "Coder did not produce a completed worktree proposal.",
        artifactRefs: [code.run.artifacts.directory],
        policyAuditRefs: [coderDispatch.policyAuditRef],
        boundaryAuditRefs: [coderBoundaryRef],
        failureClassification: "code-failure",
        requiresUserInputReason: "Implementation failed before official validation could run.",
      });
      emitDelegatedRoleReturn(input.live, input.changeId, input.roleId, "failed", "coder-agent 没有产出可验证的 worktree 结果。", code.run.artifacts.directory);
      return { leaf: "coder", roleId: input.roleId, status: "failed", code, stoppedAt: "code", orchestration };
    }

    const coderOutputArtifacts = compactArtifactRefs(code.run.artifacts.directory, code.run.artifacts.implementation);
    orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
      roleId: workflowRuntimeCoderRole(input.roleId),
      status: "completed",
      inputArtifacts: coderInputArtifacts,
      outputArtifacts: coderOutputArtifacts,
      summary: "Coder produced a completed worktree proposal.",
    });
    await settle({
      status: "completed",
      summary: "Coder produced a completed worktree proposal.",
      artifactRefs: compactArtifactRefs(code.run.artifacts.directory, code.run.artifacts.implementation),
      policyAuditRefs: [coderDispatch.policyAuditRef],
      boundaryAuditRefs: [coderBoundaryRef],
      nextRecommendation: "Run independent validation.",
    });
    emitDelegatedRoleReturn(input.live, input.changeId, input.roleId, "completed", "coder-agent 已返回实现和自测结果。", code.run.artifacts.directory);
    return { leaf: "coder", roleId: input.roleId, status: "completed", code, orchestration };
  });
}

export async function runReworkCoderLeafStage(input: Omit<Parameters<typeof runCoderLeafStage>[0], "roleId">): Promise<WorkflowRuntimeCoderLeafResult> {
  return runCoderLeafStage({ ...input, roleId: "rework-coder" });
}

export async function runValidatorLeafStage(input: {
  project: ManagedProject;
  memory: WorkflowRoleRuntimePort;
  changeId: string;
  live?: WorkflowRuntimeLiveSink;
  orchestration: WorkflowRuntimeExecutionState;
  decision: Extract<WorkflowRuntimeDecision, { kind: "delegate-role" }> & { roleId: "validator" };
  code: CodeLeafRun;
  services?: WorkflowLeafExecutionServices;
}): Promise<WorkflowRuntimeValidatorLeafResult> {
  let orchestration = input.orchestration;
  const validatorDispatch = await createDelegatedForegroundTask(input.memory, {
    conversationId: input.changeId,
    changeId: input.changeId,
    roleId: "validator",
    kind: "foreground",
    goal: input.decision.goal,
    inputArtifacts: input.decision.inputArtifacts,
    delegationMode: "orchestrator-policy",
  }, input.live);
  const validatorTask = validatorDispatch.task;
  return withForegroundRoleTaskLease<WorkflowRuntimeValidatorLeafResult>(input.memory, validatorTask, async (settle) => {
    input.live?.emit({ event: "run.status", data: { runId: input.code.run.id, status: "running", label: "Validation" } });
    input.live?.emit({ event: "tool.event", data: { runId: input.code.run.id, phase: "status", name: "Validation", status: "running" } });
    emitAssistantEvent(input.live, { runId: input.code.run.id, kind: "status", phase: "running", title: "Validation running", summary: "AHO started validation for the coder worktree." });
    let validation: ValidationLeafRun;
    try {
      validation = await (input.services ?? defaultLeafServices).startValidation(input.project, { changeId: input.changeId, worktree: input.code.run.worktree!.worktreeId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
        roleId: "validator",
        status: "failed",
        inputArtifacts: input.decision.inputArtifacts,
        outputArtifacts: [],
        failureClassification: "validation-failure",
        stoppedAt: "validation",
        summary: "Independent validation failed before validation artifacts were completed.",
      });
      await settle({
        status: "failed",
        summary: "Independent validation failed before validation artifacts were completed.",
        artifactRefs: [],
        policyAuditRefs: [validatorDispatch.policyAuditRef],
        failureClassification: "validation-failure",
        requiresUserInputReason: message,
      });
      emitDelegatedRoleReturn(input.live, input.changeId, "validator", "failed", "validator failed before validation artifacts were completed.", validatorDispatch.policyAuditRef);
      return { leaf: "validator", roleId: "validator", status: "failed", stoppedAt: "validation", error: message, orchestration };
    }

    input.live?.emit({ event: "run.status", data: { runId: input.code.run.id, status: validation.validation.status, label: "Validation" } });
    input.live?.emit({ event: "tool.event", data: { runId: input.code.run.id, phase: "status", name: "Validation", status: validation.validation.status } });
    emitValidationAssistantEvents(input.live, input.code.run.id, validation);
    const validationBoundaryAudit = await recordPostRunBoundaryAudit(input.memory, {
      changeId: input.changeId,
      roleId: "validator",
      runId: validation.run.id,
      taskId: validatorTask.id,
      artifactRefs: compactArtifactRefs(validation.run.artifacts.validation, validation.run.artifacts.stdout, validation.run.artifacts.stderr),
    });
    const validationBoundaryRef = boundaryAuditArtifactRef(input.memory, validationBoundaryAudit);
    if (validation.validation.status !== "passed") {
      const validationOutputArtifacts = compactArtifactRefs(validation.run.artifacts.validation, validation.run.artifacts.stdout, validation.run.artifacts.stderr, validationBoundaryRef);
      orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
        roleId: "validator",
        status: "failed",
        inputArtifacts: input.decision.inputArtifacts,
        outputArtifacts: validationOutputArtifacts,
        failureClassification: "validation-failure",
        stoppedAt: "validation",
        summary: "Independent validation failed.",
      });
      await settle({
        status: "failed",
        summary: "Independent validation failed.",
        artifactRefs: compactArtifactRefs(validation.run.artifacts.validation, validation.run.artifacts.stdout, validation.run.artifacts.stderr),
        policyAuditRefs: [validatorDispatch.policyAuditRef],
        boundaryAuditRefs: [validationBoundaryRef],
        failureClassification: "validation-failure",
        requiresUserInputReason: "Validation failed; bounded automatic rework may be attempted.",
      });
      emitDelegatedRoleReturn(input.live, input.changeId, "validator", "failed", "validator 返回验证失败结果。", validation.run.artifacts.validation);
      return { leaf: "validator", roleId: "validator", status: "failed", validation, stoppedAt: "validation", orchestration };
    }

    const validationOutputArtifacts = compactArtifactRefs(validation.run.artifacts.validation, validation.run.artifacts.stdout, validationBoundaryRef);
    orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
      roleId: "validator",
      status: "completed",
      inputArtifacts: input.decision.inputArtifacts,
      outputArtifacts: validationOutputArtifacts,
      summary: "Independent validation passed.",
    });
    await settle({
      status: "completed",
      summary: "Independent validation passed.",
      artifactRefs: compactArtifactRefs(validation.run.artifacts.validation, validation.run.artifacts.stdout),
      policyAuditRefs: [validatorDispatch.policyAuditRef],
      boundaryAuditRefs: [validationBoundaryRef],
      nextRecommendation: "Run semantic audit.",
    });
    emitDelegatedRoleReturn(input.live, input.changeId, "validator", "completed", "validator 返回验证通过结果。", validation.run.artifacts.validation);
    return { leaf: "validator", roleId: "validator", status: "completed", validation, orchestration };
  });
}

export async function runAuditorLeafStage(input: {
  project: ManagedProject;
  memory: WorkflowRoleRuntimePort;
  changeId: string;
  live?: WorkflowRuntimeLiveSink;
  orchestration: WorkflowRuntimeExecutionState;
  decision: Extract<WorkflowRuntimeDecision, { kind: "delegate-role" }> & { roleId: "auditor-agent" };
  code: CodeLeafRun;
  validation: ValidationLeafRun;
  services?: WorkflowLeafExecutionServices;
}): Promise<WorkflowRuntimeAuditorLeafResult> {
  let orchestration = input.orchestration;
  const auditorDispatch = await createDelegatedForegroundTask(input.memory, {
    conversationId: input.changeId,
    changeId: input.changeId,
    roleId: "auditor-agent",
    kind: "foreground",
    goal: input.decision.goal,
    inputArtifacts: input.decision.inputArtifacts,
    delegationMode: "orchestrator-policy",
  }, input.live);
  const auditorTask = auditorDispatch.task;
  return withForegroundRoleTaskLease<WorkflowRuntimeAuditorLeafResult>(input.memory, auditorTask, async (settle) => {
    input.live?.emit({ event: "run.status", data: { runId: input.code.run.id, status: "running", label: "Audit" } });
    input.live?.emit({ event: "tool.event", data: { runId: input.code.run.id, phase: "status", name: "Audit", status: "running" } });
    emitAssistantEvent(input.live, { runId: input.code.run.id, kind: "status", phase: "running", title: "Audit running", summary: "AHO started audit after validation passed." });
    let audit: AuditLeafRun;
    try {
      audit = await (input.services ?? defaultLeafServices).startAudit(input.project, {
        changeId: input.changeId,
        worktreeId: input.code.run.worktree!.worktreeId,
        prompt: "This audit was automatically started after the user confirmed the Coder run and validation passed for the same worktree.",
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
        roleId: "auditor-agent",
        status: "failed",
        inputArtifacts: input.decision.inputArtifacts,
        outputArtifacts: [],
        failureClassification: "audit-failure",
        stoppedAt: "audit",
        summary: "Independent audit failed before audit artifacts were completed.",
      });
      await settle({
        status: "failed",
        summary: "Independent audit failed before audit artifacts were completed.",
        artifactRefs: [],
        policyAuditRefs: [auditorDispatch.policyAuditRef],
        failureClassification: "audit-failure",
        requiresUserInputReason: message,
      });
      emitDelegatedRoleReturn(input.live, input.changeId, "auditor-agent", "failed", "auditor-agent failed before audit artifacts were completed.", auditorDispatch.policyAuditRef);
      return { leaf: "auditor", roleId: "auditor-agent", status: "failed", stoppedAt: "audit", error: message, orchestration };
    }

    input.live?.emit({ event: "run.status", data: { runId: input.code.run.id, status: audit.audit.status, label: "Audit" } });
    input.live?.emit({ event: "tool.event", data: { runId: input.code.run.id, phase: "status", name: "Audit", status: audit.audit.status } });
    emitAuditAssistantEvent(input.live, input.code.run.id, audit);
    const auditBoundaryAudit = await recordPostRunBoundaryAudit(input.memory, {
      changeId: input.changeId,
      roleId: "auditor-agent",
      runId: audit.run.id,
      taskId: auditorTask.id,
      artifactRefs: compactArtifactRefs(audit.audit.artifacts.audit, audit.audit.artifacts.auditMarkdown, audit.audit.artifacts.lastMessage),
    });
    const auditBoundaryRef = boundaryAuditArtifactRef(input.memory, auditBoundaryAudit);
    const auditAccepted = audit.audit.status === "approved" || audit.audit.status === "approved-with-notes";
    const auditOutputArtifacts = compactArtifactRefs(audit.audit.artifacts.audit, audit.audit.artifacts.auditMarkdown, audit.audit.artifacts.lastMessage, auditBoundaryRef);
    orchestration = recordWorkflowRuntimeExecutionStep(orchestration, {
      roleId: "auditor-agent",
      status: auditAccepted ? "completed" : "failed",
      inputArtifacts: input.decision.inputArtifacts,
      outputArtifacts: auditOutputArtifacts,
      ...(auditAccepted ? {} : { failureClassification: "audit-failure" as const, stoppedAt: "audit" as const }),
      summary: auditAccepted ? "Independent audit accepted the validated worktree evidence." : "Independent audit did not accept the worktree evidence.",
    });
    await settle({
      status: auditAccepted ? "completed" : "failed",
      summary: auditAccepted
        ? "Independent audit accepted the validated worktree evidence."
        : "Independent audit did not accept the worktree evidence.",
      artifactRefs: compactArtifactRefs(audit.audit.artifacts.audit, audit.audit.artifacts.auditMarkdown, audit.audit.artifacts.lastMessage),
      policyAuditRefs: [auditorDispatch.policyAuditRef],
      boundaryAuditRefs: [auditBoundaryRef],
      nextRecommendation: auditAccepted ? "Show result review and apply handoff." : "Attempt bounded automatic rework if budget remains.",
      ...(auditAccepted ? {} : { failureClassification: "audit-failure", requiresUserInputReason: "Audit did not accept the current evidence." }),
    });
    emitDelegatedRoleReturn(
      input.live,
      input.changeId,
      "auditor-agent",
      auditAccepted ? "completed" : "failed",
      auditAccepted
        ? "auditor-agent 返回审查通过结果。"
        : "auditor-agent 返回需要修改或补证据的结果。",
      audit.audit.artifacts.auditMarkdown,
    );
    return { leaf: "auditor", roleId: "auditor-agent", status: auditAccepted ? "completed" : "failed", audit, stoppedAt: auditAccepted ? undefined : "audit", orchestration };
  });
}

function workflowRuntimeCoderRole(roleId: string): WorkflowRuntimeRole {
  return roleId === "rework-coder" ? "rework-coder" : "coder-agent";
}
