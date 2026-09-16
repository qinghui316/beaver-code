import { fromStoredThreadMessage } from "./conversation-thread-log.js";
import type {
  ConversationTurnExecutionPorts,
  ConversationTurnStrategy,
  ConversationTurnStrategyInput,
  ConversationTurnStrategyPreflightInput,
  TurnSkillContextResolution,
} from "./conversation-turn-contract.js";
import type { ProjectRuntimeState } from "../project-runtime/coordinator.js";
import type { TopicMessageResult, TopicThreadEntry } from "./types.js";

type HarnessTurnRunner = (
  project: ConversationTurnStrategyInput["project"],
  conversationId: string,
  userMessage: string,
  live: ConversationTurnStrategyInput["live"],
  handoff: ConversationTurnStrategyInput["harnessHandoff"],
  options: {
    graphScopeId?: string;
    runtimeState: ProjectRuntimeState;
    turnSkillResolution: TurnSkillContextResolution | null;
    model: ConversationTurnStrategyInput["admission"]["model"];
    reasoningEffort: string | null;
  },
) => Promise<TopicThreadEntry>;

export class HarnessConversationTurnStrategy implements ConversationTurnStrategy {
  readonly productMode = "harness" as const;

  constructor(private readonly runTurn: HarnessTurnRunner) {}

  preflight(input: ConversationTurnStrategyPreflightInput): void {
    if (input.conversation.productMode !== "harness") {
      throw conflict("Harness Strategy requires a Harness Conversation.");
    }
    if (input.project.id !== input.conversation.projectId
      || input.committedMessage.projectId !== input.conversation.projectId
      || input.committedMessage.conversationId !== input.conversation.conversationId) {
      throw conflict("Harness Turn identity does not match the selected project and Conversation.");
    }
    if (input.providerId !== input.conversation.selectedProviderId) {
      throw conflict("Harness provider does not match the committed Conversation selection.");
    }
    if (input.runtimeState.state === "repair-required") {
      throw conflict("Project Harness requires repair before planning or source execution.");
    }
  }

  async execute(
    input: ConversationTurnStrategyInput,
    _ports: ConversationTurnExecutionPorts,
  ): Promise<TopicMessageResult> {
    this.preflight(input);
    const user = fromStoredThreadMessage(input.committedMessage);
    const assistant = await this.runTurn(
      input.project,
      input.conversation.conversationId,
      user.text ?? "",
      input.live,
      input.harnessHandoff,
      {
        graphScopeId: user.graphScopeId,
        runtimeState: input.runtimeState ?? (() => { throw new Error("Harness Turn runtime state is not composed."); })(),
        turnSkillResolution: input.turnSkillResolution,
        model: input.admission.model,
        reasoningEffort: input.admission.modelAdmission?.resolvedReasoningEffort ?? null,
      },
    );
    return {
      user,
      assistant,
      run: null,
      providerSessionId: null,
      mode: "chat",
      assistantMessage: assistant.text ?? "",
    };
  }
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}
