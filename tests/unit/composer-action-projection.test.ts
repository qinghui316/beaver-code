import { describe, expect, it } from "vitest";
import { buildComposerActionProjection } from "../../src/web/src/shell/composer.js";
import { projectComposerModelLabel } from "../../src/web/src/controllers/ComposerExperienceProjection.js";

describe("Composer action projection", () => {
  it("uses send only when idle and no queue item is ahead", () => {
    expect(buildComposerActionProjection({ running: false, hasDraft: true, canQueue: true })).toMatchObject({ primaryIntent: "send", canSubmitDraft: true });
    expect(buildComposerActionProjection({ running: false, hasDraft: true, canQueue: true, queueHasItems: true })).toMatchObject({ primaryIntent: "queue", canSubmitDraft: true });
  });

  it("projects Stop, Steer, and Queue from the current execution state", () => {
    expect(buildComposerActionProjection({ running: true, hasDraft: false, canStop: true })).toMatchObject({ primaryIntent: "stop", canStop: true });
    expect(buildComposerActionProjection({ running: true, hasDraft: true, canStop: true, canSteer: true, canQueue: true })).toMatchObject({ primaryIntent: "steer", alternativeIntent: "queue" });
    expect(buildComposerActionProjection({ running: true, hasDraft: true, hasNextTurnContext: true, canStop: true, canSteer: true, canQueue: true })).toMatchObject({ primaryIntent: "queue" });
  });

  it("never exposes a submit action while state is being reconciled", () => {
    expect(buildComposerActionProjection({ running: false, hasDraft: true, queueBusy: true })).toMatchObject({ primaryIntent: "wait", canSubmitDraft: false });
    expect(buildComposerActionProjection({ running: true, stopping: true, queueBusy: true, hasDraft: true, canStop: true })).toMatchObject({ primaryIntent: "wait", canSubmitDraft: false, canStop: false });
    expect(buildComposerActionProjection({ running: false, hasDraft: true, queueReady: false })).toMatchObject({ primaryIntent: "wait", canSubmitDraft: false });
    expect(buildComposerActionProjection({ running: true, hasDraft: true, stopping: true, canStop: true })).toMatchObject({ primaryIntent: "wait", canSubmitDraft: false, canStop: false });
  });

  it("labels the next Conversation Turn from Composer selection before observed runtime state", () => {
    const modelSettings = {
      providerId: "codex",
      selectedModel: null,
      effectiveModel: { providerId: "codex", modelId: "runtime-model" },
      effectiveModelSource: "default" as const,
      candidates: [
        {
          modelId: "composer-model",
          label: "Composer Model",
          source: "catalog",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        },
        {
          modelId: "runtime-model",
          label: "Runtime Model",
          source: "catalog",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        },
      ],
      available: true,
    };

    expect(projectComposerModelLabel({
      productMode: "agent",
      composerModelId: "composer-model",
      savedConversationModelId: "saved-model",
      modelSettings,
    })).toBe("Composer Model");
    expect(projectComposerModelLabel({
      productMode: "agent",
      composerModelId: null,
      savedConversationModelId: "removed-model",
      modelSettings,
    })).toBe("Runtime Model");
    expect(projectComposerModelLabel({
      productMode: "agent",
      savedConversationModelId: "removed-model",
      modelSettings,
    })).toBe("removed-model");
    expect(projectComposerModelLabel({
      productMode: "harness",
      composerModelId: "must-not-cross",
      modelSettings,
    })).toBe("must-not-cross");
  });
});
