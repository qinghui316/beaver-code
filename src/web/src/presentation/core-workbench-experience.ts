import type { ProductMode, ProductModeActivityState } from "../types.js";

export interface ProductModeExperienceViewModel {
  readonly mode: ProductMode;
  readonly label: "Agent" | "AHO";
  readonly title: string;
  readonly description: string;
  readonly compactDescription: string;
}

export interface WorkspaceToolViewModel {
  readonly id: "office" | "terminal" | "tools";
  readonly label: string;
  readonly openLabel: string;
  readonly closeLabel: string;
}

const MODE_EXPERIENCE: Readonly<Record<ProductMode, ProductModeExperienceViewModel>> = {
  agent: {
    mode: "agent",
    label: "Agent",
    title: "直接和 Agent 一起开发",
    description: "适合快速修改、调试和连续对话。",
    compactDescription: "直接开发",
  },
  harness: {
    mode: "harness",
    label: "AHO",
    title: "让多个 Agent 按流程协作",
    description: "先规划，再开发、测试和审查；关键步骤由你确认。",
    compactDescription: "多 Agent 协作",
  },
};

export const WORKSPACE_TOOLS: Readonly<Record<WorkspaceToolViewModel["id"], WorkspaceToolViewModel>> = {
  office: {
    id: "office",
    label: "Agent Office",
    openLabel: "打开 Agent Office",
    closeLabel: "关闭 Agent Office",
  },
  terminal: {
    id: "terminal",
    label: "Terminal",
    openLabel: "打开 Terminal",
    closeLabel: "收起 Terminal",
  },
  tools: {
    id: "tools",
    label: "工具",
    openLabel: "打开工具",
    closeLabel: "关闭工具",
  },
};

export function productModeExperience(mode: ProductMode): ProductModeExperienceViewModel {
  return MODE_EXPERIENCE[mode];
}

export function productModeControlLabel(
  mode: ProductMode,
  active: boolean,
  state: ProductModeActivityState | undefined,
): string {
  const label = MODE_EXPERIENCE[mode].label;
  if (active || !state || state === "idle" || state === "unavailable") return label;
  if (state === "attention") return `${label}，需要你处理`;
  if (state === "failed") return `${label}，需要处理`;
  return `${label}，正在执行`;
}

export function productModeControlTitle(
  mode: ProductMode,
  active: boolean,
  state: ProductModeActivityState | undefined,
): string {
  const experience = MODE_EXPERIENCE[mode];
  if (active || !state || state === "idle" || state === "unavailable") return `${experience.label} · ${experience.compactDescription}`;
  return productModeControlLabel(mode, false, state);
}
