import type { AgentTurnMode, ProductMode } from "./types.js";

export type AgentAccessMode = "default" | "full-access";

/** Immutable execution evidence, not a Composer configuration store. */
export interface AgentAccessPolicy {
  readonly version: 1;
  readonly requestedAccess: AgentAccessMode;
  readonly sandboxPolicy: "read-only" | "workspace-write" | "full-access";
  readonly approvalMode: "never" | "on-request";
  readonly networkAccess: boolean;
  readonly writableRoots: readonly string[];
}

export function parseAgentAccessMode(value: unknown): AgentAccessMode {
  if (value === undefined || value === null || value === "default") return "default";
  if (value === "full-access") return value;
  throw new Error("Invalid Agent access mode.");
}

/** Historical attempts may omit evidence; malformed recorded evidence must fail closed. */
export function parseAgentAccessPolicy(value: unknown): AgentAccessPolicy | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Agent access evidence.");
  const policy = value as Record<string, unknown>;
  if (policy.version !== 1 || !["default", "full-access"].includes(String(policy.requestedAccess))
    || !["read-only", "workspace-write", "full-access"].includes(String(policy.sandboxPolicy))
    || !["never", "on-request"].includes(String(policy.approvalMode))
    || typeof policy.networkAccess !== "boolean" || !Array.isArray(policy.writableRoots)
    || !policy.writableRoots.every((root) => typeof root === "string" && root.length > 0)) {
    throw new Error("Invalid Agent access evidence.");
  }
  const full = policy.sandboxPolicy === "full-access";
  if (policy.networkAccess !== full || (full && (policy.requestedAccess !== "full-access" || policy.approvalMode !== "never"))
    || (policy.sandboxPolicy !== "workspace-write" && policy.writableRoots.length !== 0)
    || (policy.sandboxPolicy === "workspace-write" && (policy.requestedAccess !== "default" || policy.writableRoots.length !== 1))) {
    throw new Error("Inconsistent Agent access evidence.");
  }
  return Object.freeze({ version: 1, requestedAccess: policy.requestedAccess as AgentAccessMode,
    sandboxPolicy: policy.sandboxPolicy as AgentAccessPolicy["sandboxPolicy"],
    approvalMode: policy.approvalMode as AgentAccessPolicy["approvalMode"], networkAccess: policy.networkAccess,
    writableRoots: Object.freeze([...policy.writableRoots] as string[]),
  });
}

/** No persistence, provider implementation, or application owner dependencies. */
export function resolveAgentAccessPolicy(input: {
  productMode: ProductMode;
  accessMode: AgentAccessMode;
  turnMode: AgentTurnMode;
  projectRoot: string;
  supportsFullAccess: boolean;
  supportsApproval: boolean;
  readOnlyRole?: boolean;
}): AgentAccessPolicy {
  if (input.productMode !== "agent") throw new Error("Agent access cannot override AHO execution.");
  const accessMode = parseAgentAccessMode(input.accessMode);
  const readOnly = input.turnMode === "plan" || input.readOnlyRole === true;
  if (!readOnly && accessMode === "full-access" && !input.supportsFullAccess) {
    throw new Error("Selected AI service does not support full access.");
  }
  const sandboxPolicy = readOnly ? "read-only" : accessMode === "full-access" ? "full-access" : "workspace-write";
  return Object.freeze({
    version: 1,
    requestedAccess: accessMode,
    sandboxPolicy,
    approvalMode: sandboxPolicy === "full-access" ? "never" : input.supportsApproval ? "on-request" : "never",
    networkAccess: sandboxPolicy === "full-access",
    writableRoots: Object.freeze(sandboxPolicy === "workspace-write" ? [input.projectRoot] : []),
  });
}
