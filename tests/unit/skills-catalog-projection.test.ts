import { describe, expect, it } from "vitest";
import { projectSkillsCatalog } from "../../src/web/src/controllers/skills-catalog-projection.js";
import type { SkillListItem } from "../../src/web/src/types.js";

describe("projectSkillsCatalog", () => {
  it("projects total source-scan failure as an error instead of an empty catalog", () => {
    const view = projectSkillsCatalog({
      ...input([]),
      catalogErrors: [{ path: "C:/skills/broken/SKILL.md", message: "unreadable" }],
    });

    expect(view.state.status).toBe("error");
    if (view.state.status !== "error") throw new Error("Expected an error state.");
    expect(view.state.failure.summary).toBe("技能目录暂时无法读取。");
    expect(view.state.actions.map((action) => action.id)).toEqual(["retry", "diagnostics"]);
  });

  it("deduplicates stable identities and derives factual filter counts", () => {
    const provider = skill("provider", { sourceKind: "provider-native", scope: "user", providerEnabled: false });
    const project = skill("project", { sourceKind: "project-harness", scope: "repo", providerEnabled: false });
    const custom = skill("custom", { sourceKind: "custom", scope: "user", providerEnabled: true });
    const view = projectSkillsCatalog(input([provider, provider, project, custom]));

    expect(view.totalCount).toBe(3);
    expect(view.filters).toEqual([
      { id: "all", label: "全部", count: 3 },
      { id: "enabled", label: "已启用", count: 2 },
      { id: "project", label: "项目技能", count: 1 },
      { id: "provider", label: "Agent 技能", count: 1 },
      { id: "custom", label: "自定义", count: 1 },
    ]);
  });

  it("keeps search and filtering purely presentational", () => {
    const view = projectSkillsCatalog({
      ...input([
        skill("review", { sourceKind: "provider-native", description: "Inspect a change" }),
        skill("custom", { sourceKind: "custom", description: "Prepare diagrams" }),
      ]),
      query: "diagram",
      filter: "custom",
    });

    expect(view.state.status).toBe("ready");
    if (view.state.status === "ready") expect(view.state.data.map((item) => item.skillId)).toEqual(["custom"]);
  });

  it("locks required, runtime-assigned, and project Harness Skills", () => {
    const view = projectSkillsCatalog(input([
      skill("required", { required: true, providerEnabled: false }),
      skill("runtime", { runtimeAssigned: true, providerEnabled: false }),
      skill("harness", { sourceKind: "project-harness", providerEnabled: false }),
    ]));

    expect(view.state.status).toBe("ready");
    if (view.state.status !== "ready") return;
    for (const card of view.state.data) {
      expect(card.statusLabel).toBe("项目必需");
      expect(card.canChangeProviderEnabled).toBe(false);
      expect(card.lockReason).toBeTruthy();
    }
  });

  it("keeps healthy Skills when one source reports a bounded diagnostic", () => {
    const view = projectSkillsCatalog({
      ...input([skill("healthy")]),
      catalogErrors: [{
        path: "C:/Users/example/.codex/skills/broken/SKILL.md",
        message: "ENOENT C:/Users/example/.codex/skills/broken/SKILL.md",
      }],
    });

    expect(view.state.status).toBe("ready");
    expect(view.diagnostics).toEqual([{ label: "…/broken/SKILL.md", detail: "ENOENT [本机路径已隐藏]" }]);
  });
});

function input(skills: readonly SkillListItem[]) {
  return {
    hasProject: true,
    resolved: true,
    loading: false,
    skills,
    roots: [],
    catalogErrors: [],
    failure: null,
    actionFailure: null,
    query: "",
    filter: "all" as const,
    conversationId: "conversation-1",
    selectedSkillId: null,
    sourcePath: "",
    sourcesOpen: false,
    diagnosticsOpen: false,
    busy: false,
  };
}

function skill(skillId: string, overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    skillId,
    name: skillId,
    description: `${skillId} description`,
    sourcePath: `C:/skills/${skillId}/SKILL.md`,
    sourceKind: "custom",
    scope: "repo",
    contentHash: `hash-${skillId}`,
    compatibility: { requiredCapabilities: [] },
    providerBindings: [{
      providerId: "codex",
      bindingKind: "native",
      status: "ready",
      contentHash: `hash-${skillId}`,
      scope: "repo",
    }],
    providerEnabled: true,
    required: false,
    runtimeAssigned: false,
    enabledProject: false,
    enabledTopics: [],
    disabledTopics: [],
    ...overrides,
  };
}
