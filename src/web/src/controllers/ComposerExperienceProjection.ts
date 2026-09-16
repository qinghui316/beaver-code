import type { ProductMode, ProviderModelSettingsSnapshot } from "../types.js";

export type ComposerPrimaryIntent = "send" | "steer" | "queue" | "stop" | "jump-to-request" | "wait";

export interface ComposerActionProjection {
  primaryIntent: ComposerPrimaryIntent;
  canSubmitDraft: boolean;
  canStop: boolean;
  disabledReason: string | null;
  alternativeIntent?: "queue";
}

export interface ComposerExperienceProjection {
  modelLabel: string;
  actions: ComposerActionProjection;
}

export function buildComposerActionProjection(input: {
  running: boolean;
  queueBusy?: boolean;
  stopping?: boolean;
  steerSubmitting?: boolean;
  hasDraft: boolean;
  hasNextTurnContext?: boolean;
  canSteer?: boolean;
  canQueue?: boolean;
  canStop?: boolean;
  queueHasItems?: boolean;
  queueReady?: boolean;
  disabledReason?: string | null;
}): ComposerActionProjection {
  if (input.disabledReason) {
    return { primaryIntent: "wait", canSubmitDraft: false, canStop: Boolean(input.canStop), disabledReason: input.disabledReason };
  }
  if (input.running) {
    if (input.stopping) {
      return { primaryIntent: "wait", canSubmitDraft: false, canStop: false, disabledReason: "当前执行正在停止" };
    }
    if (input.queueBusy) {
      return { primaryIntent: "wait", canSubmitDraft: false, canStop: Boolean(input.canStop), disabledReason: "正在更新会话队列" };
    }
    if (input.steerSubmitting) {
      return { primaryIntent: "wait", canSubmitDraft: false, canStop: Boolean(input.canStop), disabledReason: "正在发送给当前执行" };
    }
    if (input.hasDraft && input.canSteer && !input.hasNextTurnContext) {
      return {
        primaryIntent: "steer",
        canSubmitDraft: true,
        canStop: Boolean(input.canStop),
        disabledReason: null,
        alternativeIntent: input.canQueue ? "queue" : undefined,
      };
    }
    if (input.hasDraft && input.canQueue) {
      return { primaryIntent: "queue", canSubmitDraft: true, canStop: Boolean(input.canStop), disabledReason: null };
    }
    if (input.canStop) {
      return { primaryIntent: "stop", canSubmitDraft: false, canStop: true, disabledReason: null };
    }
    return { primaryIntent: "wait", canSubmitDraft: false, canStop: false, disabledReason: "等待当前执行完成" };
  }
  if (input.queueBusy) {
    return { primaryIntent: "wait", canSubmitDraft: false, canStop: false, disabledReason: "正在更新会话队列" };
  }
  if (input.queueReady === false) {
    return { primaryIntent: "wait", canSubmitDraft: false, canStop: false, disabledReason: "正在校准会话队列" };
  }
  if (!input.hasDraft) {
    return { primaryIntent: "send", canSubmitDraft: false, canStop: false, disabledReason: "输入内容后发送" };
  }
  if (input.queueHasItems) {
    return input.canQueue
      ? { primaryIntent: "queue", canSubmitDraft: true, canStop: false, disabledReason: null }
      : { primaryIntent: "wait", canSubmitDraft: false, canStop: false, disabledReason: "队列暂时不可用" };
  }
  return { primaryIntent: "send", canSubmitDraft: true, canStop: false, disabledReason: null };
}

export function projectComposerModelLabel(input: {
  productMode: ProductMode;
  composerModelId?: string | null;
  savedConversationModelId?: string | null;
  modelSettings?: ProviderModelSettingsSnapshot | null;
}): string {
  const effectiveModelId = input.modelSettings?.effectiveModel?.modelId ?? null;
  const selectedModelId = input.composerModelId === undefined
    ? input.savedConversationModelId ?? effectiveModelId
    : input.composerModelId ?? effectiveModelId;
  if (!selectedModelId) return input.modelSettings?.available === false ? "模型不可用" : "默认模型";
  return input.modelSettings?.candidates.find((candidate) => candidate.modelId.toLowerCase() === selectedModelId.toLowerCase())?.label
    ?? selectedModelId;
}
