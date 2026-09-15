# Boundary Decisions

Agent Harness Orchestrator is a local-first Agent Development OS with a Spec-Anchored Harness Kernel.

This document records boundaries that are expensive to change later. It is not a roadmap, implementation plan, or feature checklist.

## 1. Product North Star

AHO is not a generic multi-agent framework, ticket board, or pure chat UI. It is a project-linked demand conversation, memory, and execution harness that keeps human intent, specs, tasks, code, validation, review, and Harness evolution connected.

Multi-agent orchestration is a core execution layer for the final product. It is not the source of truth. Agents may run in parallel or sequence, but accepted Change artifacts, evidence, and human gates decide workflow state.

The long-term product chain is:

```text
Spec -> Acceptance Criteria -> Plan -> Tasks -> Context Projection
-> Disposable Agent Run -> Events / Artifacts -> Validation / Review
-> Archive -> Evolution Evidence
```

The final Workbench-facing product chain is:

```text
Natural-language request -> Demand Conversation -> Intake / Project Scan
-> Planning artifacts -> User confirm execution mode and Plan
-> Agent Orchestration -> Evidence -> authorized local apply/commit/finalize/close
-> Archive; remote landing/merge remains a separate user decision
```

The product should make AI coding controllable, reviewable, and recoverable. Faster code generation is useful only when it stays anchored to durable project memory and human-confirmed decisions.

## 1A. Orchestration Authority Matrix

Continuous main-agent orchestration is allowed only above existing Harness
truth. It may observe evidence, recommend next steps, and delegate bounded leaf
roles through explicit gates; it must not replace the workflow authority model.

| Artifact or surface | Role | Executable by itself | Workflow truth |
| --- | --- | --- | --- |
| Change/ECL files, accepted spec/plan/tasks/AC | Canonical demand state | No | Yes |
| Run, Validation, Audit, Worktree, Apply/Close records | Evidence and gated transitions | Only through existing gated actions | Yes for their domain |
| `confirmationQueue.primary` | Current human decision surface | Yes, after explicit confirmation and revalidation | Projection of current legal gate |
| Main Agent native Goal / provider thread | Turn continuity and completion judgment | No | No |
| Plan child proposal | Immutable planning evidence before acceptance | No | No |
| LLM strategy advice | Bounded read-only strategy evidence | No | No |
| WorkflowGraphPlan / WorkflowRun journal / recovery key | Execution structure and recovery evidence | No | No |
| Workpad, transcript, Agent graph, runtime log, diagnostics | User-facing projections | No | No |
| Worker `AgentTaskResult` | Leaf-role result evidence | No | No; must pass validation/audit/gates |
| Current project Harness | Cross-session project memory authored directly by assigned Maintenance/Evolution Agents | Runtime supplies project/memory roots and evidence; the Agent discovers semantic owners | Yes for current project guidance |
| Maintenance/Evolution AgentTask | Background trigger, claim, status, and evidence | No | No; it does not author content or apply patches |

`逐步确认` exposes one current legal gate at a time. `自动推进` may consume
only current-Change local transitions covered by the explicit
LocalExecutionAuthorization after an accepted plan and must stop at stale
evidence, failure, ambiguity, unsupported graph mode, completion, or any
remote/PR/merge transition. Local apply, commit, finalize,
and close may be consumed by that authorization; they are not a second UI
authority.
Neither mode may auto-confirm planning, raw scheduler dispatch, manual
IntegrationCheck, integration apply/discard, or remote/PR/merge. Project-memory
maintenance is automatic and serial per project: closes 1-4 run one Maintenance
task each, while close 5 runs Evolution instead of Maintenance. Evolution must
pass one native ECL scorer before the current Harness is edited. AgentTask owns
execution reliability; it does not select document paths or authorize content.

LLM strategy advice is not a workflow truth source, gate, controller, or
automation authority. It may influence the internal main-agent strategy kind
only through the bounded strategy-policy evidence envelope; it must not write
strategy JSONL, alter `confirmationQueue`, change runtime gate allowlists,
or drive action execution. Real main-agent runs may produce advice only as
same-run, same-Change metadata; it is stripped from visible transcript / plan /
live deltas and is passed explicitly to policy instead of being recovered from
historical replay.

## 1AA. Provider And Conversation Boundary

AHO owns Shared Conversation bindings, canonical timeline, ProviderAttempt,
Workflow/AgentTask state, authorization, and the Agent Relation Graph projection.
Provider adapters own native sessions, protocol normalization, session resume and
interrupt, native child execution, Skill/role loading, model discovery, and raw
diagnostics. The static Provider Registry resolves adapters and operation
capabilities; it is not a scheduler or state store.

`ConversationTurnRouter` owns side-effect-free admission for each new turn, and
the injected `AgentTurnModelAdmissionOwner` owns the provider-neutral model and
reasoning-effort decision. Agent admission captures the Provider, requested and
resolved model/effort, optional `turn.plan` capability snapshot, Agent turn mode,
and sandbox policy before Conversation or message persistence. Catalog reads may
report invalid global configuration but must not repair or write it. Request
hashes bind requested values while handoff and ProviderAttempt evidence bind the
resolved values. The public contract carries only provider-neutral selections
and `default | plan`; a Provider adapter alone constructs private collaboration
payloads. Plan capability remains optional and independent of model validity,
while each Plan Turn separately requires a resolved model. Harness requests
cannot carry Agent turn mode/model/effort, and Agent Plan cannot create Harness
planning or governance objects.

Direct Agent attachments cross one provider-neutral boundary. The Workbench
composition root injects one `TurnAttachmentResolver`; Composer and HTTP carry
only managed attachment IDs, Router admission carries one immutable resolution,
and the Strategy passes `imageInputs` / `fileInputs` to the selected adapter.
Only adapters may translate those inputs into private types such as Codex
`LocalImage` or `Mention`. `image.input` and `file.reference` are optional
capabilities and are not part of minimum Agent readiness or pure-text turns.

Only files uploaded into the selected project's managed Workbench attachment
directory are eligible. Arbitrary local paths, URLs, workspace-reference tokens,
binary files, cross-project IDs, metadata path substitution, and root escape fail
closed. Attachment directories may extend Provider read roots but never writable
roots. Absolute managed paths, file bodies, and base64 data remain transient at
the filesystem/Provider boundary; durable request and Timeline evidence uses
bounded attachment metadata and the existing handoff hash. Legacy
`bounded-text-preview` metadata remains readable and is promoted in-memory to a
provider file reference without rewriting historical records or changing Harness
Main's bounded-preview behavior.

First-send and Direct Agent follow-up admission completes before SSE begins.
Capability or initial attachment validation failure therefore has zero
Conversation/message/Attempt/Provider side effects and returns HTTP Conflict.
Exact create replay is checked from durable request and canonical attachment
evidence before touching the current attachment file or Provider capabilities.
Before a new Attempt, the Strategy repeats containment, existence, size, and hash
validation to close the upload-to-execution race; failure after message commit is
reported without silently dropping or rewriting the committed attachment facts.

Provider-native questions use one Workbench lifecycle owner for Agent and
Harness. Settlement reads the stored Conversation first, then proves project,
mode, Conversation, graph scope, run, Attempt, Provider, thread, turn, and
request lineage against the active Provider turn. Local validation failure may
return `submitting` to `pending` only before transport is invoked; an uncertain
transport outcome stays `submitting`, and terminal or restart recovery
interrupts requests without live-turn proof. Secret answer plaintext must not
enter SQLite, Timeline, SSE, or logs.

The same provider-neutral lifecycle owner also manages native command,
file-change, and permissions approvals, but only for `agent` Conversations.
Adapters retain raw Provider requests and expose redacted summaries plus a
bounded public decision set. Settlement must prove the exact Conversation,
graph, Attempt, run, Session, thread, turn, item, request, Provider, and role
lineage before transport. Default may grant only the exact temporary permission
profile requested for the current turn; Plan cannot approve file changes or
filesystem writes. Harness Main and Planning always send Provider approval
policy `never`; an unexpected callback fails closed and cannot create a visible
approval interaction. Provider approval is not a `WorkbenchApprovalItem`,
ExecutionAuthorization, ToolPolicyGate decision, Harness confirmation, or
permission-policy write. Uncertain transport remains submitting, terminal and
restart recovery interrupt unproven requests, and raw permission objects,
secrets, file bodies, and Provider callback state are never durable evidence.

`ConversationLifecycleOwner` is the sole public archive, restore, and permanent
delete owner for Agent and Harness Conversations. Schema 17 keeps lifecycle
revision and archive origin on the Conversation plus neutral idempotent operation
evidence. Only active Agent Conversations may be user-archived; only
`agent-user` archives may be restored; permanent deletion requires an archived
Conversation and a short-lived confirmation bound to its exact revision. The
existing Harness terminal transaction alone writes `harness-workflow` archive
metadata, and a user cannot reverse that governance transition.

Provider `session.archive` is optional and remains behind the provider-neutral
Conversation port. Local archive is authoritative and does not depend on
Provider or Harness readiness. Uncertain archive transport is never replayed;
restore must prove the same Session binding and complete unarchive when the
Provider may still be archived. Permanent deletion removes Workbench transcript,
interaction, queue, context, and unneeded Provider presentation state while
retaining a tombstone, safe fork-source boundary, and all Harness Change,
WorkflowGraph, AgentTask, Lane, worktree, Run, authorization, validation,
Integration, I2, and E1 evidence. It never deletes Provider rollout files or
project files, and managed attachments are removed only through the shared
attachment owner after all draft, queue, and canonical-message references are
absent.

`ConversationTurnControlOwner` is the single provider-neutral owner for stopping
and steering current Main turns in either product mode. SQLite Conversation,
ProviderAttempt, ThreadLink, and Timeline rows remain durable truth; the Owner
retains only process-local active-turn identity and interrupt/Steer submission
deduplication and never persists a second control state machine. Public requests
carry project, mode, Conversation, Provider, expected Attempt, and bounded client
request identities, while native thread/turn IDs remain inside adapters. Stop
before native Turn start is queued against the exact Attempt, unknown interrupt
transport stays stopping, and only an explicit Provider rejection may restore
running. Steer additionally proves the current graph, run, Session, runtime
scope, and Provider turn, and requires the optional `turn.steer` capability.
Provider acceptance precedes canonical `steering-sent` evidence; an uncertain
submission cannot be replayed, while an accepted request whose evidence write
failed may only retry the idempotent evidence write. Steer carries trimmed text
only. Attachments, Skills, file references, and Agent turn mode remain next-turn
inputs. Agent control does not require Harness readiness or use pending-feedback.

`ConversationTurnQueueOwner` is the sole persistent next-turn FIFO owner for Agent
and Harness Conversations. It stores provider-neutral Composer input, transfers it
from the scoped draft with CAS, and dispatches only through the existing Conversation
service and mode router. The Owner cannot call a Provider or create Harness workflow,
authorization, Change, AgentTask, Lane, or worktree state. Historical pending-feedback
Timeline rows are read-only history, and the Harness Workflow TaskQueue is unrelated.

Queue dispatches a queued Code Review only through the neutral
`ConversationQueuedReviewDispatchPort` injected by the Workbench composition
root. Queue must not import `ConversationReviewLifecycleOwner`; Review must not
import Queue for shared helpers. Execution revision calculation belongs to the
neutral `conversation-execution-revision` service and does not grant either
owner authority over the other lifecycle.

`ExecutionContractRegistry` is the single provider-neutral owner of execution
families, epochs, policy hashes, and adapter-version capture. Controllers and
Provider adapters consume a resolved identity but cannot define private version
schemes. A Queue item stores its creation family and epoch. Queue dispatch and
generic retry both fail closed when that identity is incompatible with the
current family epoch; only the Queue owner's durable confirmation for the exact
target family and epoch may restore dispatch eligibility. Changing one family
does not invalidate another family's queued work.

`ConversationReviewLifecycleOwner` is the sole native Code Review mutation owner.
The optional `turn.review` capability is Agent-only and does not change minimum
Provider readiness. Public contracts carry a neutral Git target, opaque Session
reference, admitted bootstrap model, read-only sandbox policy, and Review
lifecycle callbacks. Only the Provider adapter may construct native Session,
Turn, `review/start`, or inline delivery payloads. Existing Conversations retain
their native Session model configuration; only an empty-Conversation bootstrap
uses the current side-effect-free model admission.

Schema 18 introduced neutral Review operations and marks Provider Attempts and
Conversation FIFO items as `conversation-turn | review`. Review rows cannot
carry ordinary Turn mode, draft text, attachment, file-reference, Skill, model,
or effort fields, and database constraints reject Harness Review Attempts and
queue items. Git admission is repeated at dispatch and binds the actual HEAD,
base/commit SHA, and worktree-status digest. Review ACK is not completion: exact
entered/exited Review events and terminal Turn proof drive settlement. Unknown
transport is never replayed, Provider-completed settlement repair cannot invoke
the Provider again, and restart interrupts unfinished operations without proof.

Review uses Plan-equivalent approval restrictions: command/read/network
requests may enter the existing Agent interaction owner, while file changes and
filesystem-write permissions fail closed. Review can be stopped through the
shared Turn Control owner but never steered, retried as an ordinary Turn, used as
a normal fork anchor, or counted in completed Turn sequence. Its canonical
Timeline card contains only a safe target summary, actual Git admission,
Attempt identity, bounded diagnostics, and sanitized Markdown. Native Thread,
Turn, request and Review objects, absolute paths, raw payloads, and project-external
locations never cross the adapter boundary. Safe relative links may open the
existing read-only project-file panel.

No Review route, queue item, Attempt, Timeline projection, or UI control is
available to Harness mode. Review cannot create or modify Change, WorkflowGraph,
AgentTask, Lane, worktree, Run, ExecutionAuthorization, ToolPolicyGate,
confirmation, Validation, Audit, Apply, Close, Integration, I2, or E1 evidence,
and Harness governance/read-model projections must not consume Review cards.

`ConversationContextLifecycleOwner` is the sole provider-neutral owner for
context usage and compaction in Agent and Harness Conversations. Provider
adapters normalize native usage and compaction events and privately translate
`ProviderSessionRef` to their protocol; Workbench, HTTP, Snapshot, SSE, and UI do
not receive native thread identities. The current context occupancy and the
cumulative token total are separate facts. Missing or invalid window metadata
remains unknown rather than being estimated.

Canonical Timeline stores one latest usage row per opaque Session-binding hash
and one idempotent lifecycle row per compaction request. ACK is not completion:
only exact Provider item events advance `submitting -> compacting -> completed`,
and automatic compaction uses the same path. Client request and context revision
deduplication is process-local while Conversation, graph, Provider binding, and
Timeline remain durable authority. Explicit rejection may release submission;
uncertain transport stays submitting and cannot be resent. Restart without live
Provider proof interrupts unfinished evidence. Active Main/native-child Attempts
or pending Provider input/approval block manual compression.

Context actions are operational Session maintenance only. In Harness mode they
must not create or modify Change, WorkflowGraph, AgentTask, Lane, worktree,
ExecutionAuthorization, confirmation, approval, Apply, Close, Integration, I2,
or E1 evidence; compressed Provider context never replaces canonical Timeline or
Harness evidence. Durable rows exclude prompts, compacted summaries, native
thread/turn objects, file paths, environment values, and raw Provider payloads.

`ConversationTurnRetryOwner` owns only Direct Agent latest-failed-turn Retry.
The Agent-only pre-SSE endpoint accepts an asserted Conversation, Provider,
failed Attempt, source message, and client request identity. It derives one
deterministic new Attempt identity, persists bounded retry lineage in canonical
Timeline evidence, and delegates execution through the existing Router and
Direct Agent Strategy. The original Attempt and user message are immutable.
Retry revalidates current capabilities, the original actual turn mode, managed
attachment evidence, file references, and exact effective Skill inputs before
Provider effects; attachment-only input remains valid. Durable exact replay does
not rediscover capabilities or call the Provider again. Provider approvals and
temporary grants never carry over. The owner cannot accept Harness mode or
create Change, WorkflowGraph, AgentTask, Lane, worktree, Apply, Integration, I2,
or E1 evidence, and it does not alter Harness task/workflow retry semantics.

`ConversationForkLifecycleOwner` is the only public owner for Direct Agent
Conversation branching and stale-Session recovery. The optional `session.fork`
capability does not affect minimum Provider readiness. Public requests bind the
project, Agent mode, Conversation, Provider, completed Main anchor, Timeline and
opaque context revisions, and client request identity; only the adapter receives
native Session/Turn references and constructs fork, rollback, read, resume, or
archive protocol payloads. The source Conversation and native Session are
immutable, and Provider rollback is history-only: it must never restore or edit
project files.

Schema 15 stores one neutral fork operation and no native thread/turn payload.
The target Conversation receives a new graph scope and ready binding, inherits
Agent preferences and Conversation Skill enablement, and copies self-contained
canonical history through the anchor with fresh row identities and private
runtime lineage removed. Explicit stale-session recovery is admitted only from
provider-neutral evidence produced when Session resume failed before Turn start;
it targets the last successful Turn and never automatically resends failed input.
Harness requests fail before Provider transport and cannot create Change,
WorkflowGraph, AgentTask, Lane, worktree, approval, authorization, Apply, Close,
Integration, I2, or E1 evidence. Unknown transport remains submitting and is
never replayed automatically; restart interrupts operations without exact live
proof.

After Workbench restart, Agent Main Attempts left queued or running require
exact active Provider proof. Without it, startup recovery atomically marks the
Attempt failed, records a bounded Timeline diagnostic, and marks its Session
binding stale without advancing the completed-turn sequence. This recovery does
not claim live-process continuation and does not alter Harness workflow state.

Generic Workbench, Workflow, AgentTask, and UI modules must not import provider
raw protocol modules or branch on provider names. Unsupported capabilities fail
before an attempt starts. When exactly one provider is registered it may be the
deterministic default; multiple providers require an explicit conversation or
project selection and never silently select the first registry item.

Canonical timeline and Agent Relation Graph each have one server owner. The
browser cannot merge provider history, synthesize fallback identities, create
Agent nodes from live text, or maintain a second live transcript. Provider raw
history may only diagnose or reconcile already-known canonical attempts.

## 1B. Harness Workflow Runtime Architecture Boundary

The target architecture for stable multi-Agent work is recorded in
`docs/design-docs/harness-workflow-runtime-target.md`. That target is a
durable boundary for current refactors and future features, not only for the
current TaskQueue/Scheduler migration.

High-cohesion / low-coupling rules:

- **Owner first:** every new feature must declare an owner module before
  implementation. Broad facades such as Workbench chat/server shells,
  frontend app shells, CLI composition, domain `manager.ts` files, and type
  barrels may expose APIs or route calls, but they must not own new domain
  policy by default.
- **Single runtime owner:** multi-step, multi-Agent, or multi-gate execution
  belongs in `src/workflow-runtime/` under the future
  `HarnessWorkflowRunEngine`. TaskQueue, Scheduler, native Goal handoff,
  and future agent teams must not each grow separate observe/decide/run/sync
  runners. They may become workflow templates, modes, artifact inputs,
  projections, or leaf executors.
- **Leaf means leaf:** code, validation, audit, integration, scheduler worker,
  and future Codex subagent leaves execute one scoped node or stage and return
  evidence. They must not decide the next node, mutate the graph, start
  sibling/child leaves, bypass ToolPolicyGate, bypass code execution gates, or
  bypass human gates.
- **Projection is not authority:** Workbench, server read models, web UI,
  transcripts, right rails, graph canvases, and cards display facts or submit
  user intent. They do not own workflow state transitions, scheduling policy,
  permission decisions, execution truth, or completion truth.
- **Realtime projection has one adapter:** Codex app-server notifications are
  normalized with provider `threadId`, `parentThreadId`, `turnId`, `itemId`,
  Run, role, and AgentTask lineage before reaching Workbench. Request SSE and
  the project-level background SSE transport the same UI events; neither is a
  second event store or workflow authority. UI ownership must never be guessed
  from assistant text.
- **Agent surfaces use real identity:** Agent tabs and the ordinary Agent graph
  bind to a provider thread/session or a concrete Run. `roleId` supplies a
  display role only and must not merge two same-role transcripts. Runtime
  nodes such as Validator, IntegrationCheck, apply, commit, and close remain
  outside the ordinary Agent relationship graph.
- **Artifacts before execution:** WorkflowPlan / WorkflowGraphPlan artifacts
  must be confirmed and scoped before execution. Graph compile validates
  Change scope, accepted artifact hashes, source scope, dependency graph,
  permission profile, recovery-key inputs, and stale-target state; it does not
  start execution.
- **No long-term compatibility forks:** public action/API names may remain as
  thin facades, but old internal runners must be deleted once the new runtime
  covers the same behavior. Each replacement change must include new-path
  takeover, old-path deletion, and negative tests.
- **Skills are guidance, not enforcement:** Skills may guide Agents to read
  project docs and author legal workflow artifacts. They cannot enforce
  permissions, allocate worktrees, approve gates, validate source, or authorize
  apply/close.
- **Workflow authoring is not execution authority:** Plan Agent guidance owns
  the WorkflowPlan authoring contract. Workflow Runtime and Harness gates own
  execution authority. Workbench stale checks, Change matching, confirmation
  target matching, ToolPolicyGate decisions, worktree binding, validation,
  audit, apply, merge, and close checks are Harness boundary checks, not Plan
  Agent planning content.
- **Compiler is not planner:** WorkflowPlan to WorkflowGraphPlan validation may
  normalize and lock scoped runtime input, but it must not generate business
  goals, acceptance criteria, tasks, or workflow bodies that Plan Agent did not
  author and the user did not confirm.
- **Goal is visible brief, not hidden memory:** Goal is the main Agent's
  current objective, completion criteria, and state brief for a turn or round.
  It is reconstructed from Harness docs/evidence and must not become a hidden
  durable store or project memory database.
- **Plan Agent drafts Plan:** the main Agent owns Goal, state review, handoff,
  and next-round judgment. Plan Agent owns Plan / WorkflowPlan drafting and
  revision. Workbench or Harness code must not synthesize business plans,
  acceptance criteria, or workflow bodies directly from raw user text.
- **Workflow owns orchestration; worktree owns write isolation:** execution
  scheduling, waves, barriers, dependencies, recovery, and stop points belong
  to Workflow Runtime. AHO-owned worktrees isolate write-capable code leaves.
  Read-only planning/exploration/audit leaves do not need worktrees unless
  their runtime needs isolation.
- **Do not engineer leaf reasoning:** backend state may track node status,
  workspace, evidence, retries, and gates, but it must not decompose an
  Agent's internal problem-solving into a feature-local state machine.
- **Test the owner, not every duplicated path:** tests for multi-step or
  multi-Agent behavior must follow owner modules. Compiler legality belongs in
  `workflow-artifacts` tests; scheduling scenarios belong in
  `workflow-runtime` tests; execution boundaries belong in leaf contract tests;
  Workbench/server/web tests cover intent, stale-target revalidation, and
  projections. Future features must not add another observe/decide/run/sync
  test stack to justify a private runner, and replacement changes must include
  negative tests proving the retired runner is not called.
- **No adapter-only convergence:** a new owner, adapter, view, descriptor, or
  facade is architecture improvement only when it replaces an older authority,
  compresses duplicated policy, isolates an external/provider/private model, or
  makes the next similar workflow cheaper to implement. A pass-through wrapper
  between internal AHO modules is not enough. Reviews for line-count growth
  must state what old relationship was deleted or which future duplicated path
  is now avoided.
- **Contract and behavior tests before source-shape tests:** tests should lock
  public contracts, fail-closed behavior, scope targets, runtime decisions, and
  projection output. Source-string assertions are reserved for forbidden import
  directions, retired-symbol resurrection, or thin-facade sentinels; they must
  not become the main proof that a private implementation shape is correct.

## 2. Personal-First and Local-First Boundary

The primary user is an individual developer managing local repositories with tools such as Codex CLI, Claude Code, and shell commands.

Decisions:

- Project files, AHO-managed memory, run artifacts, and evidence are local-first.
- Projects must explicitly opt in before AHO writes to them.
- Team permissions, cloud sync, remote workers, and shared hosted state are deferred.
- Local workflows should not require a server, database daemon, or cloud account.
- Future team mode must build on the same memory interfaces instead of replacing them.

## 3. Spec-Anchored Boundary

The near-term target is L2 Spec-Anchored development, not immediate L3 Spec-as-Source development.

Definitions:

- L1 Spec-First: write specs before implementation, but specs may drift.
- L2 Spec-Anchored: keep specs, acceptance criteria, tests, code, and validation continuously linked.
- L3 Spec-as-Source: humans edit specs and code is generated or maintained from specs.

Decisions:

- Change is the workflow unit.
- Spec is the semantic anchor.
- Acceptance Criteria are the validation anchors.
- Run is an execution attempt.
- Artifact is auditable evidence.
- L2 is the practical product target for upcoming phases.
- L3 is a future experiment and must not be implied by current UX or docs.

## 4. Project Memory Boundary

Project memory must live in durable AHO-managed stores, not in agent chat, hidden model state, or a single runtime session.

AHO has three memory modes:

| Mode | Source of truth | Boundary |
| --- | --- | --- |
| `repo-local` | Target repository files | Current implementation and compatibility mode |
| `external-local` | AHO home on the user's machine | Personal default target |
| `remote` | Remote memory service | Future team/cross-device authoritative source |

`repo-local` is retained for compatibility, migration, portable exports, and projects that intentionally want Harness history in Git. It is not the long-term default for personal multi-project use.

`external-local` is the target personal default. The project keeps a marker and a memory map, while durable memory lives outside the business repository under AHO home.

`remote` is future team mode. In remote mode the remote service is authoritative and the local store is a cache.

Current repo-local memory locations:

```text
AGENTS.md                 routing map
docs/                     durable product, architecture, and boundary knowledge
harness/changes/          specs, plans, tasks, reviews, archive history
.agent-harness/runs/      events, logs, diffs, validation reports, run artifacts
harness/evolution/        evidence, proposals, results, controlled evolution state
```

Decisions:

- `AGENTS.md` is a map, not a memory database.
- `docs/` and Harness artifacts preserve durable project knowledge in the active memory store.
- `context.md` is a per-run projection and is not source of truth.
- Chat transcripts can inform work, but they are not durable project state unless summarized into files.
- A Workbench conversation id is not a Harness Change id. Ordinary chat does
  not create workflow truth; planning, gated actions, apply, and close must
  carry explicit Harness Change scope.
- Provider runtime scope is not Harness Change scope. Ordinary main-agent
  chat may use a conversation/runtime scope, while workflow actions must carry
  explicit Change scope only when they cross into Harness planning, gated
  execution, apply, or close.
- Goal is not project memory. Codex native Goal carries the current objective
  for one provider thread, while cross-session recovery and
  multi-person collaboration must come from Harness docs, accepted artifacts,
  run/evidence records, and STATUS handoffs.
- Workbench must not infer child-agent delegation by parsing visible main-agent
  text, user keywords, or fixed phrases. Child Agent / plan surfaces may appear
  only from real provider runtime ownership metadata or explicit Harness
  workflow actions.
- Planning content must be Agent-authored by a real parent-spawned Plan child.
  Workbench validates child lineage, currentness, and supersession before the
  Change owner atomically accepts a typed package. AHO must not invent the
  business plan, ACs, task list, or workflow body from raw user demand.
- The Main Agent supplies Goal/evidence scope and reviews the child proposal.
  User intent promotes only the current proposal into non-executing accepted
  artifacts and a graph; Workflow Runtime still requires a concrete gate.
- Deleting a Workbench conversation is a conversation-layer cleanup only. It
  must not close, abandon, cancel, move, archive, or garbage-collect any
  Harness Change, ECL files, workflow evidence, ResumePoint, current gate, or
  source state.
- Future dashboards and indexes must derive from AHO-managed memory rather than replacing it.
- External-local and remote memory must be accessed through Memory Resolver / Memory Store boundaries, not through hardcoded repo-local paths.

## 5. AGENTS.md Routing Boundary

`AGENTS.md` is the first routing document for agents entering a project.

Its job is to tell an agent where to read:

- product facts
- architecture decisions
- ECL rules
- current active change
- pending evolution
- validation commands
- task-specific docs

Decisions:

- `AGENTS.md` should stay compact and navigational.
- `AGENTS.md` should identify the memory mode and marker location.
- `AGENTS.md` should describe how to resolve durable memory, without embedding private paths or secrets.
- Detailed rules belong in `docs/` or Harness files.
- AHO may generate `context.md` for a specific run so Codex-style tools receive the necessary context even if they do not automatically follow the full routing chain.
- If durable memory is unavailable, `AGENTS.md` should instruct agents not to infer hidden history and to ask for memory attach, sync, init, or repair.

## 6. Memory / Execution Separation Boundary

AHO treats Codex-style agents as disposable executors. It does not assert that Codex, Claude Code, or another tool is internally stateless.

Decisions:

- AHO must not depend on agent-internal memory, hidden sessions, or internal tool traces.
- Each run rebuilds context from Harness memory and writes results back as artifacts.
- Agent outputs are proposals until validated, reviewed, and confirmed by a human.
- Agents communicate through files, events, diffs, validation reports, and review artifacts, not through shared chat context.
- If a runtime exposes richer session APIs later, those APIs are adapters, not the source of project truth.

## 6A. Codex Skill Bridge Boundary

AHO may use Codex plugin and skill discovery as a runtime delivery mechanism,
but Skills are runtime capabilities, not Harness workflow authority.

Decisions:

- Skill sources may be native Codex skills, AHO-managed memory skills,
  project Codex skills, or user-registered custom roots. The catalog records
  source path, source kind, and source hash. `$CODEX_HOME/skills` is discovered
  by default as read-only native Codex runtime capability, not copied project
  memory.
- SQLite records skill roots, project/topic enablement, and bridge sync state.
- `~/.codex/plugins/aho-managed` is a rebuildable runtime projection.
- AHO must not overwrite user Codex skills, oh-my-codex skills, or global Codex configuration.
- Native Codex Skills remain native and must not be copied into the AHO bridge.
  Bridge install/sync is explicit for custom, managed, and non-native project
  Skill packages; runs may warn when the bridge is out of sync but must not
  secretly write to `~/.codex`.
- Skill packages may include supporting content such as `references/`,
  `examples/`, and `scripts/`. AHO may materialize that package for Codex, but
  AHO must not directly execute skill scripts.
- Runs record enabled skill ids, runtime target, source hashes, and materialized
  hashes so Codex behavior can be audited later.

## 6A.1 Beaver Code Electron Desktop Boundary

Windows update transactions use desktop protocol V3. Main owns version checks, downloads,
release verification and installer invocation; existing Workbench owners still own Draft, Queue,
Provider, Terminal and persistence. Renderer can display one bounded update offer and return only
`later` or `install` for that exact offer. It has no generic IPC or installation API.

Preparation fences new mutations and Queue dispatch while permitting transaction-bound
draft PUTs. It saves every edited scope, checks revisions again before shutdown, and
interrupts managed work through existing owners. Failed/unknown receipts, forced exits
and timeouts never grant installation authority. No Provider request is replayed.

Download completion is non-blocking. Teardown starts only after the user explicitly chooses to
restart and update, and only after safe preparation succeeds. Ordinary application exit never
installs a downloaded update. Third-party programs' unsaved Terminal buffers cannot be saved by
Beaver Code. Windows session-end cancels installation admission.

Internal builds disable network updates; test builds isolate identity, data, and trust. Stable
packages trust only `qinghui316/beaver-code` and require an Ed25519 signature over the raw UTF-8
manifest before parsing. The signed identity binds stable SemVer, tag, full Commit, Windows x64,
and installer/blockmap names, sizes, and SHA-512 values. The cached installer and exact tagged
Release are revalidated immediately before teardown. Authenticode remains an additional future
gate rather than a substitute for channel signing. NSIS interruption recovery repairs application
binaries without deleting data. It is not an atomic installer or a promise of bidirectional
database compatibility.

Beaver Code uses Electron as its single desktop host direction. The existing
Node/TypeScript Core remains the owner of Workbench, Provider, SQLite, Terminal,
Harness workflow truth, and product orchestration. Tauri/Rust is not a parallel
desktop-host option.

Decisions:

- Node/TypeScript continues to own Change/ECL, accepted artifacts, Workbench
  APIs, Codex bridge, Skills, provider Goal/Plan-child integration, Scheduler,
  SQLite interaction stores, and project registry behavior.
- Electron Main owns windows, native menus, single-instance behavior, native
  dialogs, packaging, and desktop lifecycle. It supervises one Utility Process
  through a narrow versioned MessagePort protocol.
- The Electron Utility Process owns the existing Workbench Server composition,
  Provider Runtime, SQLite, Terminal, and Harness behavior. Business logic does
  not move into Electron Main or Renderer IPC.
- BrowserWindow uses only an authenticated random-port `127.0.0.1` HTTP/SSE
  origin. Its session token is memory-only and must not enter URLs, Renderer
  JavaScript, logs, SQLite, Timeline, Harness evidence, or project files.
- Native-heavy tools such as Terminal PTY, file watcher, native file dialogs,
  runtime log collection, and system notifications must enter through explicit
  adapter/service owners. They must not be scattered through React components,
  broad server facades, or Harness workflow modules.
- Terminal remains behind the Node `TerminalRuntime` owner and uses `node-pty`.
  `better-sqlite3` and `node-pty` native binaries must be verified against the
  packaged Electron ABI and target architecture.
- Native tools are user/project tools and runtime adapters. They do not become
  validation, audit, apply, close, scheduler, remote, PR, merge, or Harness
  evolution authority.
- Packaging is distribution and process management. It must not turn auto
  update, native shell startup, terminal output, or local process state into
  workflow truth.
- Automatic restart is allowed at most once and only with a current, explicit
  idle lease. Running work, pending interaction, stale lease, or unknown state
  enters manual recovery and never replays a Provider request.

## 6B. ECL Agent Runtime Boundary

ECL is the workflow protocol and canonical project record. It is not a single mega-prompt and must not be reduced to a Codex skill.

Phase 5F introduces an AHO-owned agent runtime bridge:

- AHO selects `agent_role`.
- AHO reads `agents/{role-id}.md` from memory or bundled profiles.
- AHO validates role write capability and required gates.
- AHO sends role instructions, bounded ECL context, and the user/task prompt to Codex.
- Codex executes the scoped run and emits artifacts.

Skills remain discoverable runtime capabilities. AHO must not inject all enabled skill bodies into every prompt. Enabled skills are recorded as available provenance; actual skill usage is only recorded when observable evidence exists.

Phase 8C keeps this execution boundary unchanged while splitting `src/code/manager.ts` into owned code execution modules. Code execution gate checks, run session setup, context packet writing, live events, Codex app-server execution, Codex exec streaming, artifact summarization, and status helpers remain implementation boundaries under the code domain. The app-server branch must preserve the resolved role id in session and active-turn metadata; a rework-coder run must not be labeled as a coder-agent run. This is metadata correctness, not a new execution capability.

Phase 8D applies the same ownership rule to integration checks. Integration-check target collection, patch workspace setup, aggregate validation, aggregate audit, IntegrationFix attempts, repository access, and apply/discard safety belong in owned integration-check modules behind the `src/integration-check/manager.ts` facade. Explicit `worktreeIds` are scoped targets: if any requested id is missing, stale, applied, discarded, preview-failed, or not ready, the integration check must fail closed instead of silently running on the remaining targets. Integration checks remain source-root apply preparation evidence, not automatic merge truth.

Phase 8E applied the ownership rule to remote handoff and PR landing. PR review, PR feedback, remote landing, and post-merge managers remain compatibility facades; schemas, artifact repositories, provider/GitHub CLI adapters, readiness checks, handoff/attempt/result records, rendering, and post-decision side effects belong in owned modules. Remote review, merge, local sync, and remote branch cleanup remain evidence-backed, human-gated transitions.

Phase 8F applies the ownership rule to source-root apply, local landing packages, Draft PR handoff, and landing queues. Apply readiness/gate, source diff attribution, Draft PR provider/source-match checks, and landing queue candidate/result orchestration belong in owned modules behind compatibility facades. Landing scoped action targets must match the execution layer, Draft PR creation must reject stale confirmation targets, and the refactor must not add unattended merge, reviewer assignment, new route/action/CLI behavior, source-root rewrite bypasses, or broader maintenance side effects.

Phase 8G applies the ownership rule to Spec-Test evidence. Workbench selected-demand status, drift, proposal, and generation must resolve the selected `changeId` instead of using project-global exactly-one-active fallback. CLI spec-test commands keep legacy single-active behavior and fail closed when multiple active Changes exist. Spec-Test proposal accept remains an evidence mapping transition only; it must not run tests, mutate source root, or bypass validation, audit, apply, or human gates.

Phase 8H applies the ownership rule to TaskQueue runtime coordination. New TaskQueue starts must carry and validate the same full typed scope used by the Workbench confirmation contract: `taskQueueProposalId`, `workflowGraphPlanId`, `readinessManifestId`, `decompositionPlanId`, and `workflowRunId`. Paused resume must carry matching `workflowRunId`, `queueRunId`, proposal, graph, readiness, and decomposition ids. Low-level queue helpers must not silently fall back from proposal/graph to mutable latest readiness/decomposition state, and TaskQueue internals belong in owned modules behind the `src/task-queue/manager.ts` facade.

Phase 8I applies the ownership rule to DemandWorker coordination. DemandWorker remains bounded local demand execution coordination evidence, not workflow truth and not a new scheduler. Schema/type definitions, artifact paths, repository reads/writes, main-orchestrator decisions, queue projection, slot policy, claim service, lifecycle transitions, and reconcile helpers belong in owned `src/demand-worker/*` modules behind the `src/demand-worker/manager.ts` facade. DemandWorker modules must not depend on Workbench, server routes, web UI, CLI command modules, or the facade they sit behind.

Phase 8J applies the ownership rule to TaskRun / WorkerLease coordination. TaskRun and WorkerLease remain execution coordination evidence, not workflow truth. Reconcile must match coder Run evidence by both `taskRunId` and the owning Change, workflow-result completion must not bind cross-Change code run or worktree links, and schemas/types, paths/artifacts, repository, lease service, start/retry, reconcile, workflow-result, and guard helpers belong in owned `src/task-run/*` modules behind the `src/task-run/manager.ts` facade. TaskRun modules must not depend on Workbench, server routes, web UI, CLI command modules, or the facade they sit behind.

Phase 8K applies the ownership rule to typed workflow artifacts. DecompositionPlan, DecompositionReadinessManifest, TaskQueueProposal, and WorkflowGraphPlan artifacts must prove their `changeId` matches the owning `changePath/change.json` before artifact reads, writes, builders, or graph compile can proceed. Cross-Change, misplaced, or forged artifacts fail closed and must not enter execution or UI projections. Schemas/types, paths/ref resolving, hashing, guards, artifact repositories, graph compile, and Markdown rendering belong in owned `src/workflow-artifacts/*` modules behind the `src/workflow-artifacts/manager.ts` facade. Workflow artifact modules must not depend on Workbench, server routes, web UI, CLI command modules, or the facade they sit behind.

Phase 8L applies the ownership rule to WorkflowRun recovery evidence. `WorkflowRun` read paths must prove persisted `run.changeId` matches the requested Change; list/projection paths must skip misplaced runs; event reads must prove each journal row matches both `changeId` and `workflowRunId`; event append must derive canonical scope from the WorkflowRun itself; and queue lifecycle sync must reject cross-Change or cross-queue binding. WorkflowRun internals belong in owned `src/workflow-run/*` modules behind the `src/workflow-run/manager.ts` facade. WorkflowRun modules must not depend on Workbench, server routes, web UI, CLI command modules, or the facade they sit behind.

Phase 8M applies the same rule to Change lifecycle metadata. Active and parking Change directories must agree with `change.json.id` and metadata state before status, close/abandon, Workbench projection, or thread-log import can trust the metadata. Archived metadata must remain archived and match its archive path when that path is recorded. Change lifecycle internals belong in owned `src/change/*` modules behind the `src/change/manager.ts` facade, while Change/ECL remains workflow truth.

Phase 8N applies the same ownership rule to Run evidence. Run schemas/types,
artifact path helpers, repository reads/lists, event append, run id generation,
context projection, local command execution, and small guards belong in owned
`src/run/*` modules behind the `src/run/manager.ts` facade. Run, Validation,
and Audit remain evidence records; they do not replace Change/ECL, accepted
artifacts, apply/close decisions, or human gates.

Phase 8O applies the same ownership rule to Worktree metadata. Worktree metadata must prove filename `worktreeId`, JSON `worktreeId`, `projectId`, and checkout root scope before status, projection, apply, remove, or mark-applied paths can trust it. List/projection paths skip invalid metadata; direct read/update/delete paths fail closed. Worktree internals belong in owned `src/worktree/*` modules behind the `src/worktree/manager.ts` facade, and those modules must not depend on Workbench, server routes, web UI, CLI command modules, or the facade they sit behind.

Phase 8P applies the same ownership rule to Validation and Audit evidence. Validation and Audit records must prove directory id, artifact id, run id, and requested Change scope before direct read, accept, close gate, apply gate, spec-test, task reconcile, queue reconcile, or workflow stage resume paths can trust them. List/projection paths skip malformed, forged, misplaced, or cross-Change evidence; direct read/show/accept paths fail closed. Validation and Audit internals belong in owned `src/validation/*` and `src/audit/*` modules behind their manager facades, and those modules must not depend on Workbench, server routes, web UI, CLI command modules, or the facade they sit behind.

The former Phase 8Q `src/workbench/chat.ts` conversation/action facade is retired. Workbench actions remain UI/action orchestration, but callers import exact Conversation, Main-turn, Workflow-bridge, Timeline, decision, and action-handler owners. No compatibility re-export may restore the facade.

Phase 8R turns the repeated ownership rule into a long-term Future Feature Module Boundary Rule. Future product features must extend owned modules first and must declare the owner module before implementation. Broad shells remain valid only for composition, dependency injection, and route/action dispatch; accepted replacements retire their compatibility entrypoints. The default non-owner locations for new main implementation logic are `src/workbench/projections/read-model.ts`, `src/server/workbench-server.ts`, `src/web/src/App.tsx`, `src/workflow-runtime/code-workflow.ts`, `src/cli/program.ts`, `src/types/index.ts`, and domain `manager.ts` facades. Deleted Workbench facades must not be recreated. File size alone remains a review signal, not a failure condition.

The frontend Workbench shell follows the same rule mechanically. Session,
provider configuration, Composer commands, Conversation actions, resource tabs
and drafts, Agent graph projection, project/request SSE routing, Main viewport,
and operation exclusion belong to their bounded controllers. `App.tsx` may
compose selectors and bind cross-owner commands, but it must not open migrated
domain APIs, own canonical transcript maps, create Agent facts, resolve resource
content, or interpret Timeline events. Panels render controlled state. The
frontend boundary lint rejects retired giant App tests and direct domain access
returning to the shell.

`ConversationComposerSurface` is the single Web presentation owner for both the
empty-Conversation and existing-Conversation Composer. It receives normalized
draft, execution, configuration, context, and action projections from existing
controllers and must not call Provider, Harness, Queue, Review, Draft, or
Conversation domain APIs directly. Product-mode differences are capability
projections within the shared layout; Harness cannot acquire Agent-only
Default/Plan, model override, Review, Steer, or other direct-Agent behavior
through presentation reuse. Primary-action projection is advisory UI state;
server admission and Conflict responses remain authoritative.

Ordinary Web Turn submission has one application path. A bounded
`clientRequestId` plus request hash provides server idempotency and is projected
through the canonical Timeline envelope. The Renderer may show a scoped
`PendingUserIntent` immediately, but that overlay is memory-only and cannot
advance canonical sequence, persist a message, authorize a Provider call, or
become Harness evidence. Reconciliation uses exact project, ProductMode,
Conversation scope, generation, and request identity; text, timestamp, array
position, and neighboring messages are not correlation mechanisms. Refresh or
Renderer reload discards unresolved overlays and never automatically resends an
uncertain request.

Settings presentation separates normal configuration from diagnostics. The
ordinary surface may expose only actionable provider/model settings and the
searchable Skill catalog. Provider capability keys, runtime/spec detail, bounded
errors, and custom Skill root paths require explicit diagnostic or advanced
drawers. The Web must not derive readiness, broaden Provider capabilities, read
arbitrary `SKILL.md` paths, or fabricate package contents. Existing Skill APIs
remain the only source for list, enable, refresh, and root-add operations, and
all project, product-mode, Conversation, and Provider assertions remain intact.

The Web presentation language owner is the only layer that turns stable domain
facts and request failures into ordinary UI copy. Primary and detail surfaces
must not render raw response bodies, exception messages, internal identities,
absolute paths, protocol states, or unregistered enum values. Bounded technical
detail may appear only inside an explicitly marked diagnostics subtree after
path and identity sanitization. This boundary does not rewrite user or external
source content: Agent messages, code, Terminal output, Git content, model names,
Skill names, and Skill bodies remain verbatim. It also cannot reinterpret domain
success, bypass HTTP Conflict, or change any admission, permission, Provider, or
Harness decision.

Presentation state uses a discriminated loading/error/empty/ready contract; only
feature controllers load data or execute recovery actions. The shared dialog
primitive owns focus lifecycle and dismissal semantics but cannot select models,
change Skills, navigate projects, or settle domain work. Project recovery buttons
are injected narrow actions backed by the existing refresh, diagnostics, and
navigation owners. Electron Main remains limited to host-level summaries and
native actions and does not reinterpret Workbench failures.

Composer draft persistence has one owner per layer. The schema-14
`ComposerDraftRepository` owns the sole durable `projectId + productMode` row and
full-snapshot compare-and-swap; the Workbench recovery service owns structured
parsing and revalidation of project-relative references and managed attachment
evidence; the Web `ComposerDraftSyncOwner` owns debounce, per-scope serialization,
and CAS tokens. `ConversationDraftController` owns only the in-memory draft,
captured-value clearing, and explicit restore/merge behavior, while
`ConversationTurnSubmissionController` retains immutable submission snapshots
and transport outcome classification. Controllers consume a neutral submission
contract rather than importing presentation. Routes and `App.tsx` only compose
these owners. Draft reads and writes must not call Provider runtime or Harness readiness,
and must not create Conversation, Timeline, Attempt, Change, WorkflowGraph,
AgentTask, Lane, worktree, Apply, Close, Integration, I2, or E1 facts. Harness
drafts carry no Agent turn mode, model, or reasoning effort, and neither product
mode may read, overwrite, or silently normalize the other's draft. Agent model
and effort preferences remain provider-neutral, use the same CAS settlement as
the rest of the draft, and reset to Auto on explicit Provider switches. SQLite
and public APIs retain attachment ids and safe relative metadata only, never
bodies, base64, preview URLs, or managed absolute paths.

Source dependency lint is a required architecture boundary. Every Web Client
strongly connected component is forbidden. At repository scope only the exact
three explicitly registered legacy components may remain; adding a member,
merging components, creating a new component, or silently changing the allowlist
fails with the concrete cycle path. The allowlist records debt and is not an
extension point for feature work.

`ProductModeActivityProjectionOwner` is the sole cross-mode activity summary
owner. It reads current Agent Surface, interaction, Workpad, Run, queue, and
governance projections and reduces each product mode to `unavailable`, `idle`,
`running`, `attention`, or `failed`. Its HTTP contract is detail-free and
read-only: it cannot create or update Conversation, Attempt, Timeline, Change,
WorkflowGraph, AgentTask, Lane, worktree, approval, authorization, Integration,
or Evolution evidence. The Web controller treats SSE as invalidation only and
never reconstructs durable state, counts, unread records, or activity details.
Harness readiness affects only the Harness indicator; Agent aggregation remains
available during onboarding or repair-required states.

Architecture growth control extends the same boundary from module placement to mechanism reuse. Feature modules may own domain-specific rules, rendering, and orchestration adapters, but shared artifact storage, lineage checks, stale revalidation, authority classification, ledger event policy, projection summary building, human-gate evidence, and ToolPolicy-related checks must not be scattered into feature-local private systems. If a feature needs a new cross-cutting capability, the change must either strengthen an existing owner or introduce a reusable owner with clear boundaries before adding feature-specific branches. File count and line count remain signals; the boundary question is whether the change lowers the cost and risk of the next similar feature.

Phase 8S makes `src/workflow-scheduler/` the owner for scheduler-readiness contracts. `SchedulerContract` is non-executing evidence for parallel TaskGraph readiness; it must not be treated as workflow truth, a sequential `WorkflowGraphPlan`, a TaskQueue start input, or an executable ODWF script. SchedulerContract compile may write typed artifacts and decision/audit evidence only. It must not create WorkflowRun, TaskQueueRun, TaskRun, WorkerLease, AgentTask, worktree, run, child Change, source mutations, or cache/replay records.

Phase 8T adds AgentScope 2.0 and AgentScope Java Harness to the reference system and names the future Runtime Continuity Layer. The next product-code work after SchedulerContract must not jump straight to a parallel executor. It should first define WorkerSession / AgentSession ownership, RuntimeWorkspace / sandbox boundaries, AgentEventEnvelope / EventSource replay, permission / external-execution records, and recovery semantics. These contracts are runtime auxiliaries. They must not replace Change/ECL, accepted Spec/Plan/Tasks/AC, Run, Validation, Audit, Apply/Close human gates, or Harness evolution, and reference code must not be vendor-copied into AHO product code.

Phase 8U defines the first Runtime Continuity Layer contract for code runs, and Phase 8V extends it to validation and audit role workers. `WorkerSession`, `RuntimeWorkspace`, `EventSource`, and `AgentEventEnvelope` artifacts are additive evidence beside the Run; they do not change `run.json`, raw Codex logs, validation/audit artifacts, Workbench projections, action payloads, or workflow truth. Canonical event scope must come from `WorkerSession`, not from raw adapter events. Direct read/append paths fail closed on cross-Change, cross-Run, cross-role, or misplaced evidence; list/projection-style helpers skip malformed evidence. This layer must not be used as a shortcut to parallel execution, child Changes, sandbox backends, permission engines, or Validation/Audit authority changes.

Phase 8W extends the Runtime Continuity event contract with permission and external-execution evidence rows in the existing `agent-events.jsonl` journal. `permission.profile.attached`, `permission.decision.recorded`, and `external-execution.requested/completed/failed` describe the role permission snapshot, existing ToolPolicy outcome, and adapter/process lifecycle for code, validation, and audit workers. They must not create a new permission authority, bypass ToolPolicyGate, prompt for HITL permission, alter Codex approval mode, change public artifacts, or create scheduler/runtime objects. Canonical scope must still come from `WorkerSession`; raw payload scope fields are ignored for the envelope.

Phase 8Y makes `src/workflow-scheduler/` the owner for Scheduler Dispatch / Reconcile dry-run evidence. `SchedulerDispatchDryRun` is a non-executing projection over a scoped SchedulerContract: it may write versioned/latest dry-run artifacts and decision/audit evidence, but it must not allocate DemandWorker slots, create WorkerLeases, create TaskRuns, create WorkflowRuns, create AgentTasks, create worktrees, create runs, create child Changes, mutate source, introduce scheduler runtime state, or authorize parallel execution. Workbench, server, and frontend code may call/display the dry-run, but must not own the scheduling logic.

Phase 8Z keeps `src/workflow-scheduler/` as owner for Scheduler Worker Session Plan / Recovery Contract evidence. `SchedulerWorkerSessionPlan` is a non-executing plan over a scoped dry-run and contract: it may write versioned/latest worker-plan artifacts and decision/audit evidence, but it must not create `WorkerSession`, `RuntimeWorkspace`, `EventSource`, `WorkflowRun`, `TaskQueueRun`, `TaskRun`, `WorkerLease`, `AgentTask`, worktree, run, child Change, scheduler runtime state, or parallel execution authorization. Workbench, server, and frontend code may call/display the worker plan, but must not own worker-session planning logic.

Phase 9A keeps `src/workflow-scheduler/` as owner for Scheduler Claim / Reconcile Plan evidence. `SchedulerClaimReconcilePlan` is a non-executing coordination plan over a scoped worker-session plan, dry-run, and contract: it may write versioned/latest claim/reconcile artifacts and decision/audit evidence, but it must not create `WorkerLease`, `WorkerSession`, `RuntimeWorkspace`, `EventSource`, `WorkflowRun`, `TaskQueueRun`, `TaskRun`, `AgentTask`, worktree, run, child Change, scheduler loop, slot allocator state, or parallel execution authorization. It must use `claimIntentId` and `plannedWorkerKey` rather than real lease/session ids. Workbench, server, and frontend code may call/display the claim/reconcile plan, but must not own claim/reconcile planning logic.

Phase 9B keeps `src/workflow-scheduler/` as owner for Scheduler Launch Preflight evidence. `SchedulerLaunchPreflight` is a non-executing launch-readiness contract over a scoped claim/reconcile plan, worker-session plan, dry-run, and contract: it may write versioned/latest launch-preflight artifacts and decision/audit evidence, but it must not pre-authorize ToolPolicy, bypass human gates, create runtime-continuity sidecars, or create any scheduler/runtime execution records. Workbench, server, and frontend code may call/display launch preflight evidence, but must not own launch-preflight planning logic.

Phase 9C keeps `src/workflow-scheduler/` as owner for SchedulerRun journal shell evidence. `SchedulerRun` is a non-executing human-gated launch-intent and recovery/journal record over a scoped checked launch preflight: it may write versioned/latest SchedulerRun artifacts, a SchedulerRun journal, and decision/audit evidence, but it must not create WorkflowRun, TaskQueueRun, TaskRun, WorkerLease, AgentTask, WorkerSession, RuntimeWorkspace, EventSource, worktree, run, child Change, scheduler loop, slot allocator state, or parallel executor records. Workbench, server, and frontend code may call/display SchedulerRun evidence, but must not own SchedulerRun preparation logic or expose parallel execution controls.

Phase 9D introduces `src/scheduler-runtime/` as owner for SchedulerRun-scoped runtime shell sidecars. `SchedulerRuntimeState`, `SchedulerRuntimeEvent`, and `SchedulerReconcileSnapshot` may record initialization, reconcile checkpoints, blocked/warning claim intent state, and runtime-shell summaries under the existing SchedulerRun identity. They must not alter the SchedulerRun JSON shape, create a second scheduler run identity, allocate WorkerLeases, create WorkerSessions/RuntimeWorkspaces/EventSources, create WorkflowRun/TaskQueueRun/TaskRun/AgentTask/worktree/run/child Change records, start scheduler loops, allocate slots, call coder/validator/auditor, or pre-authorize ToolPolicy/human gates. Workbench/server/frontend code may dispatch and display these sidecars, but must not own scheduler runtime logic.

Phase 9E extends `src/scheduler-runtime/` with `SchedulerRuntimeClaimReservation`. It may reserve claim-intent evidence for one reconcile snapshot, record source-lock reservation summaries, and mark a newer snapshot reservation as superseding an older one. It must not create or reuse real WorkerLease ids, WorkerSession ids, TaskRun ids, worktrees, runs, slots, or scheduler loops. Duplicate reservation for the same reconcile snapshot must fail closed; a newer reconcile snapshot may produce a new reservation with explicit supersession evidence.

Phase 9F adds `planning.scheduler.plan.prepare` as the user-facing Workbench scheduler plan preparation / launch-confirmation surface. The action may orchestrate existing owned scheduler modules to generate or re-read SchedulerContract, DispatchDryRun, WorkerSessionPlan, ClaimReconcilePlan, LaunchPreflight, SchedulerRun, SchedulerRuntimeState, ReconcileSnapshot, and ClaimReservation evidence, then produce a plain-language launch brief. It must not put the main implementation back into Workbench/server/frontend broad facades, must not bypass existing scoped guards or stale-target revalidation, and must preserve full generated ids in action payload, decision, and audit scope. The right confirmation queue is a Harness stage gate rather than a generic permission prompt: ordinary users confirm `准备并行执行计划` and then `确认启动这个并行执行计划`, not each internal scheduler checkpoint. Phase 9F still must not start workers, allocate leases or slots, create TaskRuns, WorkerSessions, RuntimeWorkspaces, EventSources, worktrees, runs, child Changes, scheduler loops, or parallel executor records.

Phase 9G adds `planning.scheduler.worker.start-first` as a single-worker scheduler start gate. `src/scheduler-runtime/` owns the worker-start selection, lineage guard, evidence, and runtime event append. Workbench/server/frontend code may only dispatch the action and display summaries. The action must start at most one coder-stage worker from the latest claim reservation, must use a scheduler-specific code execution gate, and must preserve full SchedulerRun / ClaimReservation / reservation intent / TaskRun / WorkerLease / worktree / run scope in decision and audit payloads. It must not reuse the sequential TaskQueue full Coder -> Validation -> Audit helper, must not start validation/audit/rework, and must not introduce whole-wave dispatch, a scheduler loop, a slot allocator, child Changes, or full parallel executor behavior.

Phase 9H adds `planning.scheduler.worker.reconcile-result` as the matching single-worker result gate. `src/scheduler-runtime/worker-result.ts` owns result reconciliation, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve full SchedulerRun / WorkerStart / ClaimReservation / reservation intent / TaskRun / WorkerLease / worktree / run scope, must require the code Run to use the scheduler-specific execution gate, and must fail closed for forged, stale, cross-Change, or mismatched evidence. It may write one scheduler-owned worker result, update the linked TaskRun to `evidence-ready` or `failed`, and release the linked WorkerLease only after terminal code evidence. It must not start validation, audit, bounded rework, a second worker, whole-wave dispatch, a scheduler loop, slot allocation, apply/landing, child Changes, or full parallel executor behavior.

Phase 9I adds `planning.scheduler.worker.validate-first` as the single-worker validation gate. `src/scheduler-runtime/worker-validation.ts` owns validation gating and scheduler-owned validation evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve full SchedulerRun / WorkerResult / WorkerStart / ClaimReservation / reservation intent / TaskRun / WorkerLease / worktree / coder Run / validation Run scope, must require the coder Run to use the scheduler-specific execution gate, and must fail closed for forged, stale, cross-Change, or mismatched evidence. It may run exactly one existing Validation path against the same worker worktree, write one scheduler-owned validation sidecar, keep the TaskRun `evidence-ready` when validation passes, and mark the TaskRun `blocked` when validation fails. It must not start audit, bounded rework, a second worker, whole-wave dispatch, a scheduler loop, slot allocation, apply/landing, child Changes, or full parallel executor behavior.

Phase 9J adds `planning.scheduler.worker.audit-first` as the single-worker audit gate. `src/scheduler-runtime/worker-audit.ts` owns audit gating and scheduler-owned audit evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve full SchedulerRun / WorkerValidation / WorkerResult / WorkerStart / ClaimReservation / reservation intent / TaskRun / WorkerLease / worktree / coder Run / validation Run / audit Run scope, must bind Audit to the exact validation run recorded by Phase 9I, and must fail closed for forged, stale, cross-Change, wrong-worktree, wrong-code-gate, or mismatched evidence. It may run exactly one existing Audit path against the same worker worktree, write one scheduler-owned audit sidecar, complete the TaskRun only when audit is `approved` / `approved-with-notes`, and block the current worker path when audit is `blocked` / `failed`. It must not start bounded rework, a second worker, whole-wave dispatch, a scheduler loop, slot allocation, apply/landing, child Changes, or full parallel executor behavior.

Phase 9K adds `planning.scheduler.worker.rework-plan.compile` as a non-executing single-worker rework planning gate. `src/scheduler-runtime/worker-rework-plan.ts` owns rework-plan gating and scheduler-owned `SchedulerRuntimeWorkerReworkPlan` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must accept only validation failed or audit blocked/failed first-worker states, preserve full SchedulerRun / RuntimeState / ClaimReservation / WorkerStart / WorkerResult / WorkerValidation / optional WorkerAudit / TaskRun / worktree / Run scope, and fail closed for forged, stale, cross-Change, approved, or unrelated evidence. It must not call `startCodeRun()`, add code execution gates, create TaskRuns, WorkerLeases, WorkerSessions, RuntimeWorkspaces, EventSources, worktrees, runs, AgentTasks, WorkflowRuns, TaskQueueRuns, child Changes, or start rework.

Phase 9L adds `planning.scheduler.worker.rework-start-first` as the first same-worktree scheduler rework execution gate. `src/scheduler-runtime/worker-rework.ts` owns rework-start gating and scheduler-owned `SchedulerRuntimeWorkerReworkStart` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve full SchedulerRun / RuntimeState / ClaimReservation / WorkerStart / WorkerResult / WorkerValidation / optional WorkerAudit / ReworkPlan / original TaskRun / target worktree / blocking Run scope, and must fail closed for forged, stale, cross-Change, duplicate, wrong-worktree, or unrelated evidence. Code execution must use `executionGate.mode = "scheduler-claim-rework"`; `existingWorktreeId` is valid only for that mode and must be rejected by direct, TaskQueue, generic rework, and scheduler reservation code gates. Phase 9L may create one rework TaskRun, one rework WorkerLease, one same-worktree rework code Run, and Runtime Continuity sidecars. It must not create a new worktree, validate/audit/reconcile the rework result, start another worker or whole wave, run a scheduler loop or slot allocator, create child Changes, run IntegrationCheck/apply/PR/merge, or act as the final multi-worktree merge path.

Phase 9M adds `planning.scheduler.worker.rework-reconcile-result` as the first same-worktree scheduler rework result reconcile gate. `src/scheduler-runtime/worker-rework-result.ts` owns rework-result gating and scheduler-owned `SchedulerRuntimeWorkerReworkResult` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve full SchedulerRun / RuntimeState / ClaimReservation / ReworkPlan / ReworkStart / original worker lineage / rework TaskRun / rework WorkerLease / worktree / rework Run scope, and must fail closed for forged, stale, cross-Change, duplicate, wrong-gate, wrong-worktree, or unrelated evidence. Rework code evidence must use `executionGate.mode = "scheduler-claim-rework"`. Phase 9M may mark the rework TaskRun `evidence-ready` or failed and release the rework WorkerLease. It must not start validation, audit, another rework, another worker or whole wave, run a scheduler loop or slot allocator, create child Changes, create new worktrees/runs, run IntegrationCheck/apply/PR/merge, or act as the final multi-worktree merge path.

Phase 9N adds `planning.scheduler.worker.rework-validate-first` as the first same-worktree scheduler rework validation gate. `src/scheduler-runtime/worker-rework-validation.ts` owns rework-validation gating and scheduler-owned `SchedulerRuntimeWorkerReworkValidation` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve full SchedulerRun / RuntimeState / ClaimReservation / ReworkPlan / ReworkStart / ReworkResult / original worker lineage / rework TaskRun / rework WorkerLease / worktree / rework Run / validation Run scope, and must fail closed for forged, stale, cross-Change, duplicate, wrong-gate, wrong-worktree, or unrelated evidence. Rework code evidence must use `executionGate.mode = "scheduler-claim-rework"`, and validation must target the same reused worktree without source-root fallback. Phase 9N may keep the rework TaskRun `evidence-ready` or mark it `blocked`; it must not start audit, another rework, another worker or whole wave, run a scheduler loop or slot allocator, create child Changes, create new worktrees/runs, run IntegrationCheck/apply/PR/merge, or act as the final multi-worktree merge path.

Phase 9O adds `planning.scheduler.worker.rework-audit-first` as the first same-worktree scheduler rework audit gate. `src/scheduler-runtime/worker-rework-audit.ts` owns rework-audit gating and scheduler-owned `SchedulerRuntimeWorkerReworkAudit` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve full SchedulerRun / RuntimeState / ClaimReservation / ReworkPlan / ReworkStart / ReworkResult / ReworkValidation / original worker lineage / rework TaskRun / rework WorkerLease / worktree / rework Run / validation Run / audit Run scope, and must fail closed for forged, stale, cross-Change, duplicate, wrong-gate, wrong-worktree, externally-completed, or unrelated evidence. Rework audit must target the same reused worktree and exact Phase 9N validation id without source-root fallback or latest generic evidence lookup. Phase 9O may complete the rework TaskRun only when audit is `approved` / `approved-with-notes`; it must not start another rework, another worker or whole wave, run a scheduler loop or slot allocator, create child Changes, create new worktrees/runs, run IntegrationCheck/apply/PR/merge, or act as the final multi-worktree merge path.

Phase 9P adds `planning.scheduler.integration-candidate.compile` as the scheduler output bridge back into AHO's existing multi-worktree integration safety chain. `src/scheduler-runtime/integration-candidate.ts` owns integration-candidate gating and scheduler-owned `SchedulerIntegrationCandidate` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve SchedulerRun / RuntimeState / latest ClaimReservation / worker audit / rework audit / TaskRun / WorkerLease / worktree / code gate / validation / audit scope, must fail closed or block outputs for forged, stale, cross-Change, duplicate, wrong-gate, already-applied, source-drifted, or not-ready evidence, and must re-run `previewWorktreeApply()` / `classifyApplyReadiness()` for each accepted output. Phase 9P must not run IntegrationCheck, aggregate validation/audit, apply, landing, PR, merge, next-worker dispatch, whole-wave dispatch, scheduler loops, slot allocation, child Changes, or create new worktrees/runs.

Phase 9Q adds `planning.scheduler.integration-check.run` as the scheduler handoff bridge into the existing IntegrationCheck path. `src/scheduler-runtime/integration-check-handoff.ts` owns handoff gating and scheduler-owned `SchedulerIntegrationCheckHandoff` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must preserve SchedulerRun / RuntimeState / latest ClaimReservation / latest SchedulerIntegrationCandidate / ready worktree / validation / audit / diff hash / source HEAD scope, must fail closed for forged, stale, cross-Change, duplicate, drifted, or not-ready targets, and must use existing `runIntegrationCheck(project, worktreeIds)` rather than a new integration engine. Phase 9Q must not apply/discard, landing, PR, merge, start next workers, whole-wave dispatch, scheduler loops, slot allocation, child Changes, or create new worktrees/runs outside the existing IntegrationCheck temporary workspace behavior.

Phase 9R adds `planning.scheduler.integration-outcome.reconcile` as the scheduler outcome bridge from existing IntegrationCheck terminal state back into scheduler-owned evidence. `src/scheduler-runtime/integration-outcome.ts` owns outcome gating and `SchedulerIntegrationOutcome` evidence, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must re-read current IntegrationCheck state, latest handoff, RuntimeState, target set, source hashes, and target worktree metadata; it must write no outcome while IntegrationCheck is still `passed`; it must require applied worktree evidence for `applied`; and it must reject `discarded` if any target has applied evidence. Phase 9R must not call apply/discard APIs, mutate source root, bypass aggregate validation/audit, landing, PR, merge, next-worker dispatch, whole-wave dispatch, scheduler loops, slot allocation, child Changes, or full parallel executor behavior.

Phase 9S adds `planning.scheduler.worker.start-next` as the scheduler next-worker gate. `src/scheduler-runtime/worker-start.ts` owns start-next selection and guard logic, while Workbench/server/frontend code only dispatches the action and displays summaries. The action must require explicit `schedulerRunId`, `schedulerClaimReservationId`, `reservationIntentId`, and `claimIntentId`, re-read latest SchedulerRun/RuntimeState/ReconcileSnapshot/ClaimReservation and prior worker evidence, reject stale or duplicate reservation intents, and fail closed if any prior worker path is unresolved. Phase 9S may create exactly one coder TaskRun, one WorkerLease, one worktree, one code run, and Runtime Continuity sidecars. It must not start validation, audit, rework, result reconcile, IntegrationCheck, apply, landing, PR, merge, whole-wave dispatch, scheduler loops, slot allocation, child Changes, or full parallel executor behavior.

Phase 9T requires current-worker quality gates and integration candidate refresh to be decided by scheduler-runtime owned helpers, not broad Workbench facades. Workbench may display and dispatch `validate-first` / `audit-first` / rework compatibility action ids, but user-facing labels must describe the current worker path once start-next exists. If approved worker or rework audit outputs are not covered by the latest scheduler integration candidate, the only primary next action is candidate refresh; stale candidates must not unlock IntegrationCheck or another worker decision.

Phase 9U requires the two-worker acceptance surface to stay inside those same boundaries. A second worker may only be started by the existing start-next gate after prior worker paths are terminal and the latest candidate proves one ready output. Current-worker quality gates must target the selected worker path and preserve scoped ids. Candidate refresh must run before IntegrationCheck handoff when a later approved output is not covered. Phase 9U must not add scheduler loop, whole-wave dispatch, slot allocation, apply/discard, landing, PR, merge, child Change creation, or full parallel executor behavior.

Phase 9V keeps scheduler integration outcome reconciliation inside `src/scheduler-runtime/integration-outcome.ts`. The owner module must re-read latest `SchedulerIntegrationCandidate`, latest `SchedulerIntegrationCheckHandoff`, runtime state, IntegrationCheck state, and target worktree metadata before recording an outcome. Existing `apply-check.apply` and `apply-check.discard` remain the only source-root mutation/terminal confirmation path; scheduler code must not add its own apply/discard action or mutate source root during outcome reconciliation.

Phase 9W keeps scheduler integration event/projection hardening inside `src/scheduler-runtime`. Scheduler integration events may summarize candidate compile, IntegrationCheck handoff, and terminal outcome recording, but they must derive canonical scope from SchedulerRun/Change state and must not become execution authorization. Workbench, server, frontend, IntegrationCheck, and apply/discard modules may consume or display this evidence, but must not own the integration event implementation or use it to bypass existing gates.

Phase 9X keeps SchedulerRun terminal completion inside `src/scheduler-runtime` with only thin SchedulerRun status/journal persistence in `src/workflow-scheduler`. Completion may summarize applied, discarded, or blocked scheduler integration outcomes for recovery/projection, but it must not create a scheduler-owned apply/discard action, mutate source root, run IntegrationCheck, start workers, dispatch whole waves, allocate slots, create child Changes, or bypass existing IntegrationCheck/apply/human gates.

Phase 9Y keeps the next step at the acceptance boundary. It may add tests, fixtures, and documentation proving the scheduler Workbench path is recoverable and honest, but it must not add new runtime authority. Any product fix must stay in the responsible owner module; no main implementation may be written back into Workbench chat/server/read-model shells, frontend shell, action registry facade, or manager facades.

Phase 9Z keeps the blocked/exhausted closeout boundary in `src/scheduler-runtime/`. `SchedulerRunBlockedCloseout` is terminal scheduler evidence for a run that cannot reach IntegrationCheck and has no legal next-worker path; it is not `SchedulerRunCompletion`, because completion remains tied to IntegrationCheck outcome/apply-discard evidence. Closeout is forbidden after IntegrationCheck handoff, SchedulerIntegrationOutcome, SchedulerRunCompletion, ready target count `>= 2`, stale candidate evidence, source hash drift, or a legal next-worker continuation. It must not run workers, validation, audit, rework, IntegrationCheck, apply/discard, landing, PR, merge, slot allocation, scheduler loop, child Change creation, new worktrees, or new runs.

Phase 10A keeps scheduler user-surface consolidation in owned modules. `src/scheduler-runtime/` remains the domain owner for scheduler legality and evidence; Workbench scheduler handler modules and confirmation read-model helpers may map existing scheduler action ids to user-facing labels and dispatch one scoped transition at a time. They must not own scheduler runtime decisions, hide multiple high-impact transitions behind one confirmation, bypass ToolPolicyGate or stale-target revalidation, write scheduler logic into `chat.ts`, server routes, frontend shells, projection facades, CLI modules, or manager facades, or create a scheduler loop, start-all control, slot allocator, source apply path, child Change path, or full parallel executor.

### Retired GoalLoop And Controlled-Scheduler Ledger

The following Phase 10-12 text is historical evidence only. Every ownership statement in this
ledger describes a former contract, not a current extension point. The referenced
GoalLoop/controller/packet/preflight/feedback, controlled Scheduler, scoped automation, and Plan
Mode paths are retired. Current work follows provider-backed Main orchestration -> real Plan child
-> typed accepted package -> one graph compiler -> Workflow Runtime and scheduler-owned concrete
gates -> IntegrationCheck/apply. Do not restore any legacy symbol or behavior from this ledger.

The retired Phase 10-12 GoalLoop/controller/packet/preflight/feedback and assisted-action contracts
have no current owner or execution path. Their stable constraints remain current: recommendations are
not authorization, exact targets and accepted artifacts must be revalidated, Workbench stays a
projection/intent surface, and ToolPolicy/human gates remain outside model output.

Current ownership is provider-backed Main orchestration -> real Plan child -> Change acceptance ->
Workflow Runtime and scheduler-owned concrete gates -> IntegrationCheck/apply. Any future loop or
automation requires a new accepted Change and must extend those owners without restoring retired
GoalLoop symbols, actions, projections, or a second truth source.
## 7. Memory Unavailable Boundary

Memory can be unavailable on a new machine, after a plain repository clone, when AHO home was not synced, when permissions are missing, or when a future remote memory service is offline.

Decisions:

- A marker without resolvable durable memory is an incomplete project context.
- Agents must not invent active changes, archive history, or prior decisions.
- Agents may read public repository docs and source for low-risk analysis.
- High-impact work should pause until memory is attached, synced, initialized, or repaired.
- Missing memory is a product state to surface, not a reason to silently fall back to chat history.

## 8. Human Confirmation And Local Authorization Boundary

High-impact transitions require either a current explicit human confirmation or
a limited local execution authorization issued by the confirmed Plan decision.

Confirmation gates:

- Spec Agent output requires human confirmation before planning depends on it.
- Planner Agent output requires human confirmation before coding starts.
- Coder diff requires validation and audit before apply or merge. Local apply may
  consume current scoped authorization; remote merge remains separately confirmed.
- Validator failure blocks close by default.
- Auditor approval is not merge authority.
- Local finalize/close may consume the same current scoped authorization only
  after terminal evidence and a durable close receipt. It cannot authorize
  remote merge or Harness evolution.
- Managed-project Harness Evolution is an automatic background path: it remains
  read-only until one native score reaches 80 with no hard issue, then the same
  assigned Agent edits directly and Runtime verifies mechanically.

Decisions:

- Agent output is a proposal, not a command.
- AHO can automate preparation, execution, validation, and evidence collection.
- Humans retain final product authority through Plan-scoped local authorization
  and separate remote/merge decisions. Automatic managed-project memory work is
  evidence-scoped and cannot widen product or Runtime authority.

Local authorization is versioned, bounded, revocable before commit-point
reservation, and bound to project, Change, conversation/provider lineage,
accepted artifact hashes, source state, policy, target manifest, epoch, expiry,
and budget. Each transition uses a deterministic operation identity, claim,
fencing token, and durable commit-point reservation. Before reservation the
owner revalidates all authority and source facts. After reservation, external
Git/filesystem commit points are recovered forward to one canonical receipt;
they are not rolled back or silently re-executed. Workbench and Agents cannot
provide authorization ids, manifests, fencing tokens, or target overrides.

## 9. Demand Conversation / Change / Run / Artifact Boundary

Demand Conversation is the user-visible unit of work. A Change is the internal workflow and evidence object bound to that conversation. A Run is one execution attempt against a Change.

Relationship:

```text
Project -> Conversation window
Project -> Harness Change / Workpad -> Run -> Events / Artifacts
```

Decisions:

- Users should see projects and demand conversations, not internal Topic/Change/Workpad terminology.
- A Workbench conversation is not a Change identity. It may reference workflow
  metadata when a real Harness flow exists, but write-capable actions must carry
  explicit Change scope.
- After a demand conversation is archived, implementation-class follow-up input creates a linked follow-up conversation rather than rebinding the old conversation to a new Change.
- A Change may have multiple runs.
- A failed run must not erase change history.
- Artifacts should be durable enough for review, resume, dashboard display, and evolution evidence.
- Run artifacts should include context projection, events, logs, diffs, validation results, and review outputs where available.
- Archive history is evidence for future Harness evolution.

## 10. Workbench Boundary

The personal GUI is conversation-first. The left sidebar groups demand conversations under project folders. The center is the main planning/execution conversation. The right inspector shows the current demand's result, evidence, and high-impact decisions. Internal Workpad and Topic records may still exist as read-model/API compatibility layers, but they are not primary user concepts.

Decisions:

- One demand conversation maps to one internal Change/Workpad.
- A new independent demand creates a new conversation and new Change.
- The main conversation handles clarification, planning drafts, execution confirmation, run results, result review, and user feedback.
- Workpad is an internal control-surface/read-model term. It does not replace `spec.md`, `plan.md`, `tasks.md`, `ac-map.json`, run artifacts, validation, audit, apply, or close records.
- Topic is an internal/historical/API compatibility term and should not be the primary user-facing label.
- Thread View is a narrative projection over demand conversation records, Change facts, Runs, and decisions.
- Agent Loop View exposes run-level streaming, tool/event detail, future replay, and future interrupt/cancel controls.
- A cancelled or interrupted Run does not close the owning Change.
- GUI snapshots are derived views and must not become a second workflow database.

## 10A. TaskGraph / Agent Orchestration Boundary

Future multi-agent execution is driven by TaskGraph, not by unbounded agent group chat.

Decisions:

- TaskGraph comes from accepted Plan/Tasks and may be materialized as a generated artifact, but it must remain linked to canonical ECL files.
- Each task needs stable id, title, role, dependencies, status, assigned run, evidence, and gate.
- Agent runs must bind to `projectId + changeId + taskId + roleId + runId + workspace/session`.
- Worker leases, retry queues, blocked states, and app-server sessions are runtime state. They must reconcile back to Change/TaskGraph facts.
- Agents hand off through artifacts, diffs, validation, audit, and Workpad summaries, not hidden shared memory.
- External queues such as Linear may be future adapters, but cannot be required for the local-first product.

## 10B. Agent Visualization Boundary

The current Agent Office and any future activity maps are presentation, not
workflow truth. The Office projects canonical Agent Surface identity and
provider lifecycle into a Pixi scene; its placement and animation state cannot
create Agents or execution facts.

Decisions:

- Agent animation derives from canonical Agent Surface/provider state, runtime
  events, and evidence.
- Office calibration V5 is the only production choreography configuration.
  Handoff space is stored once and reverse travel is derived; action mirror
  choices are keyed by stable action-instance identity. V4 plus mirror-patch
  files are migration inputs only.
- `OfficeActivityCompiler` owns actor depth semantics and emits explicit
  `seated`/`mobile` commands. Rendering may reparent an existing actor visual,
  but may not infer posture from action names, global Y sorting, or business
  state.
- The visual state can show reading, coding, validating, auditing, waiting, blocked, retrying, or completed.
- Clicking the visual state should lead to evidence and raw logs.
- The animation must not be the only place where state exists.
- The UI must not imply an agent completed work unless canonical evidence and gates support that state.

## 11. Thread / Run Boundary

Demand Conversation, internal Topic/Thread records, Run, and Session are different objects.

Decisions:

- Demand Conversation is the user-facing interaction surface for one demand. Internally it binds to Topic/Change/Workpad records and is persisted for continuity, but it is not the accepted specification.
- Thread View is the user-facing narrative projection over conversation records, accepted Change facts, Runs, artifacts, and decisions.
- Run is the executable attempt with live events, stream output, artifacts, and future interrupt/cancel controls.
- Codex Session IDs may exist as runtime helpers for ordinary chat continuity, but they must not replace Change as the workflow unit or the durable memory store as source of truth.
- Interrupting, cancelling, or replaying a Run changes run state only; it does not accept a proposal, close a Change, or rewrite canonical ECL files by itself.
- Thread View must remain rebuildable from durable facts and must not become an independent source of truth.

## 12. Decision Inspector Boundary

The Decision Inspector is a selected-demand actionable view, not a new source of truth.

It may surface:

- planning proposals ready for execution confirmation;
- role/result cards and evidence;
- worktrees ready to apply or merge;
- demand conversations ready to finish or abandon;
- Harness evolution proposals awaiting approval.

Accepting a decision updates the underlying canonical object. The inspector itself must be rebuildable from canonical state.

Pending decisions must show what the user is accepting, including proposal/run/worktree/artifact evidence. Accepted and completed decisions may stay visible as interaction history, but they do not become workflow truth. A request-changes decision records user feedback and suggests a follow-up proposal/run; it must not directly rewrite canonical files.

Accepted, consumed, applied, discarded, or closed items must leave the pending queue. De-duplication must be backed by canonical artifacts, accepted events, or action records that point back to canonical evidence.

## 13. Worktree vs Container Boundary

Worktree isolation is the default direction for local code-change isolation.

Worktrees provide:

- independent file trees
- independent diffs
- reduced pollution of the main working tree
- easier review and discard
- possible parallel runs

Worktrees do not provide:

- process isolation
- network isolation
- environment-variable isolation
- credential isolation
- dependency sandboxing
- OS-level security boundaries

Decisions:

- Worktree is a code-change isolation layer, not a complete security sandbox.
- Phase 2/3 should converge toward worktree execution for coding and Harness evolution.
- Direct execution may exist only as an explicit local convenience mode.
- Container sandboxing is a future optional layer for higher-risk, team, or remote execution scenarios.
- Automatic merge is out of scope until explicitly added behind human approval gates.

## 14. Codex-Style Executor Boundary

Codex CLI, Claude Code, and similar tools are external runtimes.

What AHO can reasonably do:

- generate a context projection
- choose the working directory or worktree
- invoke a process
- capture stdout and stderr
- record start and end state
- collect git diff
- run validation commands
- ask another agent or human to review outputs

What AHO must not rely on:

- hidden runtime memory
- exact internal reasoning
- exact internal tool-call sequence
- runtime-specific session continuity
- complete isolation from local files unless an actual sandbox exists

Fallback strategy:

- Use `context.md` instead of runtime memory.
- Use events, logs, diffs, validation, and review artifacts instead of internal traces.
- Use worktrees and explicit cwd boundaries instead of assuming sandbox safety.
- Use human confirmation gates for high-impact decisions.

Write-mode Coder boundary:

- `aho run codex` remains read-only proposal capture.
- `aho code run` is a write-capable command only after the Harness typed readiness gate authorizes direct single-change code execution.
- Workbench `code.run`, CLI `aho code run`, and lower-level code-run helpers must share the same DecompositionReadinessManifest gate; direct code execution is rejected when readiness is missing, stale, forged, blocked, or points to a sequential TaskQueueProposal path.
- TaskQueue-internal coder/rework execution is not direct `code.run`; it must carry a matching `WorkflowGraphPlan`, TaskQueueProposal snapshot, readiness snapshot, queue item, and `taskRunId`. Cross-queue, stale graph, missing graph, or mutable latest-file fallback is rejected before write mode.
- Phase 7M requires TaskQueue resume and TaskQueue start confirmation to preserve full typed scope from Workbench projection through UI payload, server stale-target revalidation, ToolPolicyGate audit, and low-level runtime validation. Phase 8H makes the low-level new-start path match that contract: missing or explicitly mismatched proposal, graph, readiness, decomposition, workflow, or queue ids fail closed.
- Workbench, runtime, server, frontend, CLI, and domain behavior belongs in
  bounded owner modules. Composition roots may wire owners and stable public
  entrypoints may re-export domain contracts, but neither may accumulate domain
  policy, private state machines, projections, persistence, or fallback paths.
  Compatibility facades are transitional only: once an accepted replacement
  migrates all callers and passes its owner, aggregate, boundary, and real
  acceptance gates, the covered facade and compatibility exports must be
  deleted in the same Change. Historical phase-by-phase ownership evidence
  remains in archived Change summaries and the generated index.
- Coder execution must use an AHO-owned worktree checkout as cwd.
- Source project root is read/context only during Coder execution.
- Coder prompt profiles are product assets and must encode ECL source-of-truth order, explore-first discipline, smallest coherent diff, and proposal-only status.
- A Coder run may produce a dirty worktree and diff artifacts, but it must not apply, merge, close, archive, or evolve Harness rules.
- If the source project root changes during a Coder run, the run is failed and preserved as evidence.

Apply/discard boundary:

- The apply owner consumes a validated and audited worktree diff only through
  the current scoped authorization/transition contract. CLI apply is an
  administrative facade over that owner, not a second authority path.
- Apply is not merge, PR, push, or close.
- Apply requires matching `worktreeDiffHash` across the current worktree diff, validation evidence, audit evidence, and accepted review.
- Apply derives an exact canonical manifest, stages only those paths in an
  operation-owned index, verifies expected parent/tree/diff, and commits with a
  compare-and-swap ref update. Source drift fails closed; AHO does not reset,
  rebase, auto-merge, or absorb unrelated changes.
- ApplyTransaction and close transaction recover every durable stage. Apply
  evidence, FinalizeRequest, close receipt, archive/outbox, and native Goal
  completion must preserve one lineage; Goal completion cannot precede the
  durable close receipt.
- `aho worktree discard` only discards an unapplied worktree proposal. It does not revert source repo changes.

## 15. Validation and Auditor Boundary

Validation and audit are separate gates.

Validation answers whether commands and checks passed. Audit answers whether the change appears correct, aligned with the spec, and safe to apply.

Decisions:

- Validation results should be mechanical and artifact-backed.
- Validation is scoped to a Change and must not be treated as project-wide blanket approval.
- In early phases, no validation is warning-only while latest failed validation is blocking.
- In Phase 3C, no audit and failed audit are warning-only; only explicit `blocked` audit status blocks close.
- In Phase 3D, Coder self-reported verification is not authoritative validation.
- Auditor output is a proposal and cannot apply or merge by itself.
- A Coder run that passes validation can still be rejected by audit or human review.
- In Phase 3E, apply requires validation and audit evidence for the exact current worktree diff hash, not just the same change or worktree id.
- Phase 8P requires Validation/Audit artifacts to prove directory id, artifact id, run id, and Change scope before direct read, accept, close gate, apply gate, spec-test, task reconcile, queue reconcile, or workflow stage resume paths trust them.
- Phase 8P list/projection paths skip malformed, forged, misplaced, or cross-Change Validation/Audit evidence; direct read/show/accept paths fail closed.
- `acceptAudit()` must reject forged or misplaced audit evidence and must validate any referenced validation evidence under the same Change scope.

Spec and Planner agents exist to prepare canonical ECL artifacts, not to bypass them.

- `aho change spec propose` is read-only and proposal-only.
- `aho change spec accept` is the human confirmation command that writes `spec.md`.
- `aho change plan propose` is read-only and proposal-only.
- `aho change plan accept` is the human confirmation command that writes `plan.md` and `tasks.md`, then rebuilds `ac-map.json`.
- Spec Agent must stay in WHAT/WHY; Planner must stay in HOW/tasks.
- Accept commands are stale-safe and must not overwrite user edits made after proposal generation.
- Accepting spec or plan does not run code, validation, audit, apply, close, or spec-test evidence acceptance.

Spec-Test mapping links Acceptance Criteria to test or validation evidence. It is evidence, not proof.

- `spec-tests.json` records explicit links from AC IDs to files, test names, validation commands, or notes.
- File existence and command validation status can be checked mechanically.
- Test names are human-auditable labels only in Phase 4A; AHO does not parse runner output.
- Phase 4B may ask Codex to propose existing evidence, but Codex must not directly edit `spec-tests.json`.
- AHO writes accepted evidence only after an explicit human confirmation command.
- In Phase 4B, only `source-root` `existingEvidence` can be accepted. Worktree-only evidence, suggested new tests, open questions, and unknown evidence stay proposal-only.
- Phase 4C may ask Codex to generate missing passing test evidence in an AHO-owned worktree, but the generator is test-only and proposal-only.
- Phase 4C generated tests do not become source-root evidence until validation, audit, human apply, and a later `spec-test propose` / `proposal accept` pass.
- Phase 4C rejects generator diffs that touch production code, package manifests, docs, Harness files, or `.agent-harness`.
- Phase 4C does not support accepted red tests; failing generated tests remain worktree proposals and must not be applied as evidence.
- Phase 4D drift diagnostics are deterministic risk signals. They do not call Codex, do not generate tests, and do not prove AC coverage.
- `stale` means the evidence may need refresh because validation or spec/task timestamps no longer line up; it is not proof that code and spec are inconsistent.
- `spec-test check --strict` can fail on invalid, stale, or failed accepted evidence, but missing evidence remains warning-only in Phase 4D.
- Missing linked evidence is warning-only. Broken linked evidence, such as a missing referenced file, is blocking.
- Later drift gates may become stricter only after the mapping and generation flows are stable.
- A failed validation should produce evidence for fixing code, improving specs, or evolving Harness rules.
- Spec-linked validation starts as warnings until the mapping model is mature enough to fail CI reliably.

## 16. Declarative Agent Spec Boundary

Future multi-agent scheduling must use declared roles, scoped Runs, artifacts, and approvals.

Decisions:

- Current bundled role profiles remain role contracts.
- Future Agent Specs should declare role id, description, allowed inputs, allowed outputs, write capability, preferred runtime, human confirmation requirements, and whether delegation is allowed.
- Role/subagent declarations may guide future schedulers, but they must not replace accepted specs, plans, tasks, or human gates.
- Multi-agent collaboration must not depend on a shared unbounded chat transcript.

## 17. Harness Evolution Boundary

Harness evolution improves the collaboration system, not business code directly.

This section governs evolution of AHO's own system rules and product templates.
Automatic managed-project memory maintenance is a separate AgentTask path: it
may edit only assigned project Markdown and cannot modify AHO product source,
built-in Skills, scripts, permissions, or automation policy.

Allowed evolution targets:

- process rules
- templates
- ECL guidance
- lint checks
- validation defaults
- documentation
- agent routing guidance

Decisions:

- Evolution evidence comes from archived changes, validation failures, repeated user corrections, spec drift, weak acceptance criteria, and review findings.
- Evolution must use evidence, proposal, review, validation, and human approval.
- Evolution must not automatically edit business code.
- Evolution must not silently rewrite business specs.
- No independent review means no automatic apply.

## 18. Public Repo vs Local Harness Boundary

The open-source repository should remain a usable product repository, not a dump of local agent work history.

Public assets:

- product source code
- public docs
- tests
- templates
- package and build configuration

Local development state by default:

- active and archived local changes
- reference project checkouts
- run logs and events
- worktrees
- local registry
- temporary artifacts

Decisions:

- Product Harness templates are public assets.
- This repository's own local Harness workspace is development state.
- Publishing internal ECL history is optional and must not be required for users to clone, install, or understand the product.
- External-local memory strengthens this boundary by keeping private run history and project-specific agent state outside the business repository.
- Project markers must not contain secrets, user home paths, or machine-specific credentials.

## 19. Deferred Boundaries

These areas are intentionally deferred:

- team permissions
- cloud sync
- remote managed agents
- remote memory gateway/server
- cross-project knowledge memory
- hosted dashboard
- container sandbox by default
- credential vault implementation
- automatic merge
- full Spec-to-Test generation
- CI drift failure gates for all changes
- L3 Spec-as-Source workflow

Each requires a future architecture decision before implementation.

## 20. Current Defaults

Current defaults:

- local-first
- personal-first
- explicit opt-in
- demand-conversation user surface with internal Change-driven workflow
- Spec-Anchored direction
- repo-local Harness/docs/artifacts as current implementation
- external-local as the target personal memory mode
- remote memory deferred as future authoritative team mode
- Codex-style tools treated as disposable executors
- worktree isolation as the preferred direction
- high-impact product and remote transitions require the documented human gate
  or current bounded local authorization
- no automatic merge
- managed-project Evolution may edit only after its native score gate; AHO
  system evolution remains an ordinary structured Change
- public repo excludes local Harness runtime history by default

## 21. Workbench Persistence Ownership

Workbench SQLite persistence has one dependency direction:

```text
composition owner
-> WorkbenchDatabase
-> database-upgrade owner
-> bounded repositories
-> schema v19 tables
```

- `src/workbench/persistence/database.ts` owns the shared repository connection lifetime and
  transactions. `database-upgrade.ts` is the only owner allowed to create that connection,
  inspect compatibility, configure WAL, create upgrade snapshots, restore them, or invoke the
  explicit migration chain.
- Timeline, Conversation, ProviderAttempt, Interaction, Skill, and Decision
  repositories share that connection. They must not open or close SQLite or
  import coordinators, SSE delivery, read models, provider adapters, or
  Workflow Runtime.
- Cross-table state transitions use named `WorkbenchUnitOfWork` commands.
  Provider, filesystem, Git, Harness, and Workflow calls stay outside the
  synchronous SQLite transaction.
- Upgrade quiescence is supplied through the existing composition-owned guard port. Persistence
  consumes that narrow port and must not import Provider, Workflow, or Agent Task owners to decide
  whether a migration may start.
- Schema 16, 17, 18, and 19 are the only automatic compatibility window. Each transition is explicit,
  validated, and forward-only. Populated older or future schemas are preserved byte-for-byte and
  rejected; no unsupported version may fall back to table deletion or cumulative current-DDL
  mutation.
- A schema-changing open checkpoints SQLite, writes a verified sidecar snapshot and receipt, and
  then migrates in one exclusive transaction. Failure restores the snapshot and leaves a retry
  suppression marker. Schema 19 opens do not create routine backups.
- Schema 19 stores immutable execution identity on Provider Attempts and creation identity plus
  exact confirmation receipts for Conversation Queue. The 18 -> 19 migration preserves old facts
  as `legacy-v0`; it neither rewrites history nor treats a legacy item as current behavior.
- Migration snapshots cover Workbench SQLite only. Registry, Harness evidence, user Git projects,
  and Electron Chromium caches remain with their existing owners. Electron Main cannot read or
  migrate business data.
- `src/workbench/store.ts`, `WorkbenchStore`, compatibility exports, and
  repository-local connections are retired and must not be restored.

## 22. Canonical Timeline Delivery And Conversation Coordination

Canonical Timeline has four exact owners:

- `canonical-timeline-contract.ts` owns transport types and imports no Database,
  provider, read-model, server, UI, or aggregate Workbench type.
- `canonical-timeline-projector.ts` converts a committed stored row into one envelope.
- `canonical-timeline-query.ts` owns cursor validation, paging, and watermark reads.
- `canonical-timeline-delivery.ts` is the only Workbench patch publisher and
  guarantees persistence before publication. Publication failure never rolls
  back SQLite; latest-page calibration recovers transport loss.

Conversation coordination is split among `conversation-service.ts`,
`main-agent-turn-coordinator.ts`, `provider-capture-persistence.ts`,
`provider-input-lifecycle.ts`, `planning-child-lifecycle.ts`, and
`workflow-conversation-bridge.ts`. Server, CLI, Interaction, and action callers
import the exact owner. `chat.ts`, `manager.ts`, `canonical-timeline.ts`,
`conversation-thread.ts`, caller-owned identity sets, direct patch emitters,
and compatibility re-exports are retired.

## 23. Turn Skill Resolution And Router Composition

The Workbench server composition root owns one provider-neutral
`ProjectSkillRuntimeContextResolver` and one `ConversationTurnRouter`. The
Router resolves a non-onboarding turn's runtime state and Skill context before
dispatching to the Agent or ready Harness strategy. Strategies and the Main
coordinator consume the required resolution; they do not create a production
fallback resolver or use a global empty context. Provider request inputs,
required-native Skill evidence, and handoff hashes are derived from that same
immutable resolution.

Agent mode does not require Harness readiness. It can load ordinary Skills in
onboarding or repair-required runtime states, may select the physical project
Harness as an optional Skill, and hides the three AHO orchestration Skills.
Ready Harness Main adds the project Harness and `aho-main-orchestration` as
required inputs. Harness onboarding remains on its dedicated path with zero
ready-turn Skill resolution. Missing or invalid required Skills fail before
Attempt or Provider effects; optional discovery errors are bounded diagnostics.

Skill list, reload, enable, and root APIs require `productMode`. Optional
`conversationId` and `providerId` values are assertions when a Conversation is
present; stored mode and Provider are authoritative, and mismatches return
Conflict before catalog or mutation side effects. The only uncomposed
Conversation compatibility path is `runMainAgent: false` persistence setup; a
real create-after-send, follow-up, continuation, child follow-up, or plan
settlement without an explicit composed Router fails closed.

## 24. Project Startup Availability

Project startup availability is a process-local projection, not a new Harness truth. The Project
Runtime Coordinator alone may mark a registered project `unavailable`; Workbench lists that project
with a bounded explanation, and every execution path continues to pass through strict runtime
admission. UI state cannot override the admission result. Repairing files takes effect after a new
Workbench process resolves the project again.

Provider content hashing does not traverse Project Harness `state/`, does not rewrite historical
Attempt evidence, and does not replace Change, Registry, Integration, Evolution, or validation
digests. Stable content rejects links and path escape. The separate ordinary Skill package limit is
retained as a resource boundary.

## 25. Workbench Presentation Boundary

React surfaces consume user-facing ViewModels and invoke narrow action ports. They
must not decode raw Provider, Queue, Review, Harness, persistence, or protocol
records. Presentation adapters are pure and own only display choices such as mode
guidance, project/conversation grouping, visible confirmation counts, and service
labels. Existing feature controllers remain the mutation owners.

`App.tsx` is the composition root, not a feature state machine. It may bind the
selected project, product mode, Conversation, and controller instances, but feature
status projection belongs to the corresponding adapter. Electron Main and Preload
do not receive Conversation presentation or business dependencies.

The shared Agent/AHO layout does not weaken product-mode isolation. Agent-only
model overrides, Default/Plan, Review, and direct-turn controls remain absent from
AHO. AHO governance and operation-profile facts remain server-owned even when both
modes use the same React surface.

Supporting-surface accessibility remains a presentation concern. Touch target
size, responsive wrapping, focusable truncated identities, diagnostic disclosure,
Git status labels, and Terminal tab semantics may change without changing the
underlying Git, Terminal, Provider, Skill, project, or Conversation owners.
Terminal retry reopens the same scoped terminal through the existing HTTP owner;
it does not create a second runtime or move PTY ownership into React. Technical
diagnostics remain present in the DOM only inside their explicitly collapsed
advanced disclosure and never become ordinary readiness facts.
