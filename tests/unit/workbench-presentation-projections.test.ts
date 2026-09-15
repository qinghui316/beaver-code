import { describe, expect, it } from "vitest";
import { projectConversationWorkspaceChrome } from "../../src/web/src/presentation/conversation-workspace.js";
import {
  groupProjectNavigationConversations,
  projectNavigationConversations,
} from "../../src/web/src/presentation/project-navigation.js";
import type { Snapshot } from "../../src/web/src/types.js";

describe("core Workbench presentation projections", () => {
  it("keeps governance counts out of Agent presentation while preserving the selected service label", () => {
    expect(projectConversationWorkspaceChrome({
      governanceVisible: false,
      primaryConfirmationPresent: true,
      otherConfirmationCount: 2,
      maintenanceConfirmationCount: 1,
      providerDiagnosticName: null,
      selectedProviderId: "codex",
      providerOptions: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude Code" }],
    })).toEqual({ pendingConfirmationCount: 0, providerDisplayName: "Codex" });
  });

  it("projects and searches active and archived conversations without mutating the snapshot", () => {
    const snapshot = {
      left: {
        workpads: [
          { id: "active", title: "订单校验", state: "active", runtimeStatus: "running", userStatus: "executing", userStatusLabel: "执行中", selected: true, waitingDecisionCount: 1 },
          { id: "archive", title: "历史导入", state: "archive", runtimeStatus: "archived", userStatus: "completed", userStatusLabel: "已完成", selected: false, waitingDecisionCount: 0 },
        ],
        topics: [],
      },
    } as unknown as Snapshot;
    const conversations = projectNavigationConversations(snapshot, "active");
    const groups = groupProjectNavigationConversations(conversations, "历史");

    expect(groups.active).toEqual([]);
    expect(groups.archived.map((item) => item.id)).toEqual(["archive"]);
    expect(groups.hasSearchMatch).toBe(true);
    expect(snapshot.left.workpads?.map((item) => item.id)).toEqual(["active", "archive"]);
  });
});
