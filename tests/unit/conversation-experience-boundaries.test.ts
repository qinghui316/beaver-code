import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ConversationDraftLifecyclePorts,
  ConversationExecutionActionPorts,
  ConversationSubmissionCoordinatorPorts,
} from "../../src/web/src/controllers/conversation-composer-contract.js";

// `npm run typecheck:contracts` compiles these negative capability assertions.
// @ts-expect-error Draft lifecycle cannot create Conversations.
export type DraftLifecycleCannotCreateConversation = ConversationDraftLifecyclePorts["session"]["createConversation"];
// @ts-expect-error Submission cannot steer a running Turn.
export type SubmissionCannotSteer = ConversationSubmissionCoordinatorPorts["actions"]["steer"];
// @ts-expect-error Submission cannot stop a running Turn.
export type SubmissionCannotStop = ConversationSubmissionCoordinatorPorts["actions"]["stop"];
// @ts-expect-error Execution actions cannot submit a normal message.
export type ExecutionCannotSendMessage = ConversationExecutionActionPorts["actions"]["sendMessage"];
// @ts-expect-error Execution actions cannot mutate optimistic Timeline rows.
export type ExecutionCannotShowPending = ConversationExecutionActionPorts["timeline"]["showPending"];

function assertNestedComposerPortsAreReadonly(
  draft: ConversationDraftLifecyclePorts,
  execution: ConversationExecutionActionPorts,
): void {
  // @ts-expect-error Draft API methods cannot be replaced by a lifecycle owner.
  draft.drafts!.save = draft.drafts!.save;
  // @ts-expect-error Queue snapshots are immutable projections.
  execution.queue!.snapshot!.revision = "queue:forged";
  // @ts-expect-error Queue item collections cannot be mutated in place.
  execution.queue!.snapshot!.items.push(execution.queue!.snapshot!.items[0]!);
  // @ts-expect-error Queue methods cannot be replaced by an execution owner.
  execution.queue!.enqueue = execution.queue!.enqueue;
}

void assertNestedComposerPortsAreReadonly;

describe("Conversation experience boundaries", () => {
  it("keeps application contracts independent of presentation", () => {
    for (const path of [
      "src/web/src/controllers/ConversationDraftController.ts",
      "src/web/src/controllers/ConversationTurnSubmissionController.ts",
      "src/web/src/controllers/conversation-submission-contract.ts",
      "src/web/src/controllers/useConversationComposerController.ts",
    ]) {
      expect(read(path), path).not.toMatch(/from\s+["'][^"']*presentation\/conversation-experience/);
    }
  });

  it("keeps the experience projection pure and out of domain owners", () => {
    const projection = read("src/web/src/controllers/ComposerExperienceProjection.ts");
    expect(projection).not.toMatch(/\.\.\/\.\.\/workbench|provider-runtime|\.\.\/api/);
    expect(projection).not.toMatch(/fetch\(|postJson|fetchJson|useState|useEffect/);
  });

  it("keeps Draft ownership away from transport, Timeline, Provider, and persistence", () => {
    const draft = read("src/web/src/controllers/ConversationDraftController.ts");
    expect(importSources(draft)).not.toMatch(/\.\.\/api|canonicalTimeline|provider-runtime|ComposerDraftSyncOwner/);
    expect(draft).not.toMatch(/fetch\(|postJson/);
  });

  it("keeps Queue and Review behind the neutral dispatch port", () => {
    const queue = read("src/workbench/conversation-turn-queue.ts");
    const review = read("src/workbench/conversation-review-lifecycle.ts");
    expect(queue).not.toContain('from "./conversation-review-lifecycle.js"');
    expect(review).not.toContain('from "./conversation-turn-queue.js"');
    expect(queue).toContain('from "./conversation-input-delivery.js"');
    const delivery = read("src/workbench/conversation-input-delivery.ts");
    expect(delivery).toContain('from "./conversation-queued-review-dispatch.js"');
    expect(delivery).not.toContain('from "./conversation-turn-queue.js"');
    expect(review).toContain("implements ConversationQueuedReviewDispatchPort");
  });

  it("keeps App and Electron hosts out of Conversation implementation owners", () => {
    const app = read("src/web/src/App.tsx");
    expect(app).not.toMatch(/ConversationDraftController|ConversationTurnSubmissionController/);
    expect(app).not.toMatch(/projectComposerModelLabel/);
    for (const path of ["src/desktop/main.ts", "src/desktop/utility.ts"]) {
      expect(read(path), path).not.toMatch(/ConversationDraftController|ConversationTurnSubmissionController|ComposerExperienceProjection/);
    }
  });

  it("keeps submission lifecycle transport and optimistic mutations in the submission owner", () => {
    const hook = read("src/web/src/controllers/useConversationComposerController.ts");
    const owner = read("src/web/src/controllers/ConversationTurnSubmissionController.ts");
    const composition = read("src/web/src/controllers/ConversationSubmissionComposition.ts");
    expect(hook).not.toMatch(/consumeWorkbenchLiveStream/);
    expect(hook).not.toMatch(/await\s+portsRef\.current\.session\.createConversation/);
    expect(hook).not.toMatch(/portsRef\.current\.timeline\.(showPending|markPending)\?\.\(/);
    expect(owner).not.toMatch(/from\s+["']react["']|useState|useEffect|useMemo/);
    expect(owner).not.toMatch(/consumeWorkbenchLiveStream|WorkbenchRequestError|userFacingErrorMessage/);
    expect(composition).toMatch(/consumeWorkbenchLiveStream/);
    expect(owner).toMatch(/\.session\.createConversation\(/);
    expect(owner).toMatch(/\.timeline\.showPending\?\./);
  });

  it("keeps the Composer hook as a thin composition root", () => {
    const hook = read("src/web/src/controllers/useConversationComposerController.ts");
    expect(hook.split(/\r?\n/).length).toBeLessThan(220);
    expect(hook).not.toMatch(/fetch\(|fetchJson|postJson|\/api\//);
    expect(hook).not.toMatch(/\.actions\.(steer|stop)|\.queue\.(enqueue|reclaim)|\.timeline\.calibrate/);
    expect(hook).toMatch(/useConversationDraftLifecycle/);
    expect(hook).toMatch(/useConversationComposerResources/);
    expect(hook).toMatch(/useConversationSubmissionCoordinator/);
    expect(hook).toMatch(/useConversationExecutionActions/);
  });

  it("keeps extracted Composer owners acyclic and composed only by the root hook", () => {
    const ownerPaths = [
      "src/web/src/controllers/useConversationDraftLifecycle.ts",
      "src/web/src/controllers/useConversationComposerResources.ts",
      "src/web/src/controllers/useConversationSubmissionCoordinator.ts",
      "src/web/src/controllers/useConversationExecutionActions.ts",
    ];
    for (const path of ownerPaths) {
      const imports = importSources(read(path));
      expect(imports, path).not.toMatch(/\.\/useConversation(?:DraftLifecycle|ComposerResources|SubmissionCoordinator|ExecutionActions)/);
    }
    const contractImports = importSources(read("src/web/src/controllers/conversation-composer-contract.ts"));
    expect(contractImports).not.toMatch(/\.\/useConversation/);
  });

  it("gives each extracted Composer owner only its declared capability ports", () => {
    const contract = read("src/web/src/controllers/conversation-composer-contract.ts");
    const hook = read("src/web/src/controllers/useConversationComposerController.ts");
    expect(contract).not.toMatch(/Conversation(?:DraftLifecycle|ComposerResource|SubmissionCoordinator|ExecutionAction)Ports\s*=\s*Pick</);
    expect(hook).toMatch(/createConversationComposerPortViews/);
    expect(hook).not.toMatch(/useConversation(?:DraftLifecycle|ComposerResources|SubmissionCoordinator|ExecutionActions)\([^\n]*portsRef/);

    const draft = read("src/web/src/controllers/useConversationDraftLifecycle.ts");
    expect(draft).toMatch(/CurrentValueRef<ConversationDraftLifecyclePorts>/);
    expect(draft).not.toMatch(/portsRef\.current\.(?:actions|queue|timeline|skills|attachments|projection|operation|ids)/);

    const resources = read("src/web/src/controllers/useConversationComposerResources.ts");
    expect(resources).toMatch(/CurrentValueRef<ConversationComposerResourcePorts>/);
    expect(resources).not.toMatch(/portsRef\.current\.(?:actions|queue|timeline|projection|operation|ids|drafts|session)/);

    const submission = read("src/web/src/controllers/useConversationSubmissionCoordinator.ts");
    expect(submission).toMatch(/CurrentValueRef<ConversationSubmissionCoordinatorPorts>/);
    expect(submission).not.toMatch(/portsRef\.current\.(?:queue|skills|drafts)/);

    const execution = read("src/web/src/controllers/useConversationExecutionActions.ts");
    expect(execution).toMatch(/CurrentValueRef<ConversationExecutionActionPorts>/);
    expect(execution).not.toMatch(/portsRef\.current\.(?:skills|attachments|drafts|session|projection)/);
  });
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function importSources(source: string): string {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).join("\n");
}
