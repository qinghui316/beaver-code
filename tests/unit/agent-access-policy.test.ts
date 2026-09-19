import { describe, expect, it } from "vitest";
import { parseAgentAccessMode, parseAgentAccessPolicy, resolveAgentAccessPolicy } from "../../src/provider-runtime/agent-access-policy.js";

const base = { productMode: "agent", accessMode: "default", turnMode: "default",
  projectRoot: "/project", supportsFullAccess: true, supportsApproval: true } as const;

describe("Agent access execution policy", () => {
  it("validates recorded policy while preserving missing historical evidence", () => {
    expect(parseAgentAccessPolicy(null)).toBeNull();
    const policy = resolveAgentAccessPolicy(base);
    expect(parseAgentAccessPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
    for (const changed of [{ version: 2 }, { networkAccess: true }, { requestedAccess: "admin" },
      { sandboxPolicy: "full-access" }, { writableRoots: [] }]) {
      expect(() => parseAgentAccessPolicy({ ...policy, ...changed })).toThrow();
    }
  });
  it("preserves default workspace and approval restrictions", () => {
    expect(resolveAgentAccessPolicy(base)).toEqual({
      version: 1, requestedAccess: "default", sandboxPolicy: "workspace-write",
      approvalMode: "on-request", networkAccess: false, writableRoots: ["/project"],
    });
  });
  it("only enables full access for an explicitly capable provider", () => {
    expect(resolveAgentAccessPolicy({ ...base, accessMode: "full-access" })).toMatchObject({
      sandboxPolicy: "full-access", approvalMode: "never", networkAccess: true, writableRoots: [],
    });
    expect(() => resolveAgentAccessPolicy({ ...base, accessMode: "full-access", supportsFullAccess: false })).toThrow();
  });
  it.each([{ turnMode: "plan" as const }, { readOnlyRole: true }])("keeps restricted actions read-only: %j", (restriction) => {
    expect(resolveAgentAccessPolicy({ ...base, accessMode: "full-access", ...restriction })).toMatchObject({
      requestedAccess: "full-access", sandboxPolicy: "read-only", networkAccess: false, writableRoots: [],
    });
  });
  it("rejects AHO overrides", () => {
    expect(() => resolveAgentAccessPolicy({ ...base, productMode: "harness" })).toThrow();
  });
  it("defaults historical absence, but rejects malformed access", () => {
    expect(parseAgentAccessMode(undefined)).toBe("default");
    expect(parseAgentAccessMode(null)).toBe("default");
    for (const value of ["", "admin", {}, false, 1]) expect(() => parseAgentAccessMode(value)).toThrow();
  });
  it("freezes policy and roots against later configuration mutation", () => {
    const policy = resolveAgentAccessPolicy(base);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.writableRoots)).toBe(true);
  });
});
