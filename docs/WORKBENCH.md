# Workbench

## Desktop update preparation

In an updater-enabled desktop build, verified downloads automatically enter a bounded
save-and-restart flow. The work surface is temporarily non-editable while its existing
draft owners save all scopes through CAS. Uploads, stale revisions or uncertain requests
cancel update preparation. The Help menu provides checking/retry and diagnostic access.
Internal builds show that updating is disabled; ordinary Web Workbench has no installer.

An active Agent/AHO/Review task is interrupted through its existing runtime owner only
after preparation succeeds. Queued input and application-owned history survive restart.
Terminal programs are ended; their unsaved in-process buffers are outside draft storage.

The current Workbench reads one Shared Conversation and one canonical timeline.
Provider events are persisted before `timeline.patch` is emitted; the browser
upserts the same canonical cell identity and snapshots only calibrate it. The
browser may retain expansion, pinned-scroll, open Agent tabs, loading/error, and
composer draft state, but it cannot own message, Agent, Workflow, or provider
facts.

The server-owned Agent Relation Graph is the only Agent graph source. It contains
one logical Main root and only real provider Agent threads in the current demand
scope. Clicking a child opens its provider-qualified transcript in the existing
right-side browser-style tabs; clicking Main returns to the center conversation.
Runtime validation, integration, apply, commit, and close stages remain outside
the user Agent graph.

With one installed provider the existing Codex name, model picker, trust/repair,
settings, and diagnostics experience remains visible without a redundant
provider selector. A selector appears only when multiple providers are actually
registered. Ordinary UI never exposes provider/session/thread/attempt/canonical
identity fields.

Turn Skill composition is server-owned. Each non-onboarding Agent or ready
Harness turn resolves runtime identity, discovery roots, persisted selections,
and required overlays once through the composed Conversation Turn Router. The
same immutable resolution supplies Provider Skill inputs, native required Skill
evidence, and the handoff hash. Harness onboarding keeps its dedicated Main plus
engineering path and does not perform ready-turn Skill discovery. Skill API
requests carry explicit product mode and may assert Conversation and Provider
identity; stored Conversation identity is authoritative and mismatches fail
closed before Provider effects.

Ordinary Agent conversations have per-send `Default / Plan`, model, and reasoning
effort controls. `Default` uses the admitted project workspace-write sandbox.
`Plan` is available when the selected Provider reports the optional `turn.plan`
protocol capability, uses a read-only sandbox with no writable roots, and also
requires this Turn to resolve an effective model. Model and effort may follow the
current Provider configuration/defaults or select one exact catalog option. An
invalid explicit selection remains visible and blocks sending instead of falling
back. One immutable admission captures the requested and resolved values before
the user message, ProviderAttempt, or Provider turn is created. The adapter alone
constructs any private Plan payload. Harness conversations expose none of these
Agent controls and continue through their existing operation-profile model path.

The existing-Conversation and empty-Conversation entry points render one shared
`ConversationComposerSurface`. It owns one bordered input container, selected
context items, one compact footer, and the responsive placement of Default/Plan,
context usage, model, and two fixed action slots. The context-action slot and
primary-action slot remain in the DOM across idle, sending, thinking, replying,
stopping, and interaction states. Send and Stop reuse the same fixed primary
slot; Steer, `稍后发送`, or `查看待处理事项` can occupy only the fixed context
slot. The page controllers still own
draft CAS, generation fencing, Review, Queue, Steer, Stop, and send commands.
Product mode projects available controls into this surface; it does not fork the
layout or grant Agent-only actions to Harness conversations. Attachments, project
file references, and selected Skills remain individually identifiable and
removable above the editor. Low-frequency additions live behind the `+` menu,
while Queue and running-turn actions only appear when their current snapshots
make them relevant.

The Composer model label means “the model that the next Agent Turn will use.”
It resolves from the current Composer selection, then the Conversation's saved
selection, then the selected Provider default. Changing it updates the label
immediately and does not rewrite the immutable model snapshot of a running Turn.
The actual model used by the current Turn belongs in Turn detail or diagnostics.
AHO continues to use its Harness operation profile and exposes no Agent per-Turn
model override.

Workbench Settings has two user-facing destinations: `模型与服务` and `技能`.
The normal provider view shows connection state, effective default
model, source, and actions that can actually change or refresh configuration.
Capability keys, spec/runtime states, versions, and bounded errors appear only
in an on-demand diagnostics drawer. The Skills page uses grouped searchable
results and temporary detail/source drawers. Ordinary rows and details never
show absolute source paths; real custom-root paths are confined to the explicit
advanced source-management flow. The browser uses only the existing catalog
contract and does not open arbitrary local paths or synthesize package content.

All product-authored Workbench copy passes through one user-facing language
policy. Primary labels stay concise, recovery details explain the next useful
action, and protocol or persistence terminology appears only in an explicit
diagnostics surface. Common developer objects such as Git, Branch, Commit, Diff,
PR, Terminal, Token, Agent, and model names remain recognizable. Feature labels
use the shared Chinese vocabulary, including `默认`, `计划`, `技能`, `代码审查`,
`上下文`, `稍后发送`, and `从这里创建新会话`. User input, Agent output, code,
Terminal output, Git content, model names, Skill names, and Skill bodies remain
verbatim rather than being rewritten by the presentation layer.

Composer drafts are durable full snapshots scoped by `projectId + productMode`.
They reuse the schema-14 `composer_drafts` row and include unsent text, safe
project-relative file references, managed attachment ids, provider-neutral Skill
overrides, the selected Provider id, and the Agent Default/Plan, model, and effort
preferences. Harness snapshots always store null Agent turn/model/effort fields,
and Agent and Harness never read or update each other's draft row. Draft IO does
not require Harness readiness, invoke a Provider, or create Conversation,
Timeline, Attempt, Change, Workflow, or authorization evidence.

The draft API writes one complete snapshot with `updatedAt` compare-and-swap.
Stale saves and deletes return the current server snapshot without overwriting
newer input. The Composer serializes saves per scope, debounces ordinary edits,
and flushes before send, scope changes, and page hide. Restore revalidates file
root containment and symlink segments, managed attachment ownership and hashes,
and current Skill/Provider availability. Invalid evidence is omitted with bounded
diagnostics; no file body, base64 data, preview URL, or managed absolute path is
stored or returned. An unavailable saved Provider or Plan choice remains visible
and blocks sending until the user selects a supported configuration. Explicit
model or effort selections behave the same way. Switching Provider resets both
to automatic defaults rather than inheriting same-named options across Providers.

An ordinary Web send captures one immutable draft snapshot and bounded
`clientRequestId`, then inserts the user row into the existing canonical Timeline
surface immediately as a memory-only optimistic intent. The accepted snapshot is
cleared by captured value, so input added while the request is running wins the
CAS race and cannot be removed by the older settlement. A matching canonical
Timeline envelope replaces the optimistic row by request identity; equal text,
timestamps, or neighboring rows are never used to guess correlation. First-send
temporary Conversation scope is rekeyed only after an exact matching create
receipt. Refresh restores canonical rows only and does not replay an unresolved
request.

The visible response lifecycle is `正在发送 -> 正在思考 -> 正在回复 -> terminal`.
`正在思考` begins only from the exact Turn-started fact, its timer survives SSE
reconnect, and the first real assistant text delta advances the same active row
to `正在回复`. Completion without a text delta terminalizes that row directly.
Late deltas, old generations, old Attempts, and events for another Conversation
cannot reopen or duplicate it.

A failure proven to have no Provider side effect remains as a failed user row
with explicit `重试` and `放回输入框` actions. Retry uses a new request identity.
An unknown transport result is shown as awaiting confirmation, is reconciled
against canonical Snapshot/SSE state, and cannot be automatically or silently
resent. If the canonical user message already exists and the Provider later
fails, the message stays canonical and recovery uses the existing Turn recovery
path rather than returning the message to Composer. Accepted Steer still clears
only its captured text, and Stop clears nothing. Conversation navigation keeps
the established shared project/mode Composer scope rather than creating
per-Conversation draft rows.

The `Agent / AHO` selector shows one compact icon on the inactive mode when the
selected project has running work, needs user attention, or has a current
failure there. The server returns only the aggregate mode state and update time;
it does not expose counts, Conversation identity, titles, messages, paths, or
Provider-private identity. Clicking the indicator performs the existing mode
switch and leaves Conversation selection, Composer drafts, Provider activity,
and Harness governance untouched. SSE events only invalidate the indicator;
the browser reloads the canonical read-only projection after debounce and after
reconnect, without polling or creating unread state.

Agent and AHO conversations share one provider-neutral context indicator in the
Composer footer. `ConversationContextLifecycleOwner` derives current context
usage from the selected Conversation's ready Provider binding, stores only the
latest normalized usage plus bounded compaction lifecycle evidence, and projects
an opaque `contextRevision`. Current occupancy uses the Provider-normalized last
input plus cached-input usage; cumulative totals are display statistics and are
never treated as current occupancy. If the Provider does not publish a reliable
context window, the UI shows token counts without estimating a percentage.

Manual compression uses the same short JSON endpoint in both product modes and
passes only a provider-neutral Session reference to the adapter. Provider ACK
leaves the lifecycle at `submitting`; exact compaction item events move it through
`compacting` to `completed` or `failed`. Automatic item events use the same owner
and durable projection. Requests are bound to Conversation, mode, Provider,
current graph, ready Session, client request, and opaque revision; active Main or
child attempts and pending Provider input/approval disable the action. SSE only
invalidates the selected Conversation snapshot. No native thread id, prompt,
compacted summary, path, or raw Provider payload enters the browser or durable
context evidence. AHO compression does not create or advance any Harness
governance, authorization, workflow, Apply, Integration, I2, or E1 fact.

Direct Agent also exposes Codex-native inline Code Review through one
`ConversationReviewLifecycleOwner`. The Composer button and strict `/review`
command share the same Git selector for uncommitted changes, a base branch, a
commit, or custom instructions. An idle existing Conversation reuses its
Provider Session and native model configuration. Starting from an empty
Composer creates a recoverable Agent Conversation and a read-only Session using
the currently admitted Provider, model, and reasoning effort. Review never
captures attachments, file references, Skills, or the next ordinary Turn's
mode/model settings.

Schema 18 records an Agent-only Review operation and discriminates Review
Attempts and shared FIFO items from ordinary Conversation Turns. A queued Review
revalidates the actual Git HEAD, target ref, commit, and worktree digest when it
reaches the queue head. Exact Provider events drive `submitting -> reviewing ->
completed`; uncertain transport is not replayed, restart interrupts unproven
work, and stale Sessions use the existing explicit recovery-fork path. The
Timeline renders one persistent Markdown Review card. Provider output paths are
contained and normalized before storage; safe relative Markdown links open the
existing project-file resource panel, while external or unresolved paths are
redacted. Review is stoppable but cannot be steered, cannot write project files,
and is absent from AHO mode and all Harness validation, audit, authorization,
confirmation, and governance projections.

Schema 19 records which versioned execution contract a Provider Attempt used.
The identity is split by Agent turn, Code Review, native child, and AHO role so
an incompatible change affects only its own execution family. Conversation
Queue items remember the family and epoch at creation. If that family advances,
the item remains intact but shows `执行方式已更新，需要确认后发送`; the user must
choose `按当前方式发送` before the Queue owner may dispatch it. Ordinary retry
cannot bypass this confirmation, and historical Attempts remain readable as the
behavior that actually ran rather than being rewritten to current policy.

Ordinary Agent turns accept Composer-managed images and safe text/code files in
both Default and Plan mode. One server-owned `TurnAttachmentResolver` validates
project ownership, the exact managed attachment directory, type, size, and
SHA-256, then produces immutable provider-neutral image/file inputs, safe
evidence, read-only runtime roots, and a stable handoff hash. Codex maps those
inputs privately to `LocalImage` and `Mention`; Workbench, Router, Composer, and
SQLite do not depend on those protocol types. Attachment roots are readable
runtime context only: Default can still write only the project root, while Plan
has no writable roots.

Create and Agent follow-up routes prepare attachment and capability admission
before opening SSE. Missing `image.input` or `file.reference`, invalid ownership,
or changed upload evidence therefore returns HTTP Conflict before a new
Conversation, user message, ProviderAttempt, Timeline event, or Provider turn is
created. A committed exact create replay is proved from the stored request and
canonical attachment metadata before physical attachment access, so it neither
rediscovers capabilities nor invokes the Provider again. Execution revalidates
file existence, containment, size, and hash immediately before Attempt creation;
a later failure keeps the committed user message and Composer selection for
diagnosis and retry. Successful send clears only the current Composer selection,
not the managed files referenced by canonical history.

Agent Plan output is ordinary canonical assistant content. Realtime plan updates
are temporary presentation events; the completed Provider `planText` calibrates
the durable final message. It does not create a Harness Change, Planning Agent
proposal, execution approval, or Plan handoff. Provider-native questions from
Agent and Harness turns share one durable interaction lifecycle. Answers target
the exact active Provider turn, secret values are persisted only as redacted
placeholders, and an unproven submission remains `submitting` rather than being
replayed.

Ordinary Agent turns may also expose the selected Provider's native command,
file-change, and temporary-permission approvals through that same interaction
lifecycle. The Dock stores and displays only a provider-neutral, redacted
summary; the adapter retains the private request and constructs the exact
response. Default turns can grant only the request's bounded current-turn
permissions. Plan turns remain read-only, so file changes and filesystem-write
permission requests can only be declined or stopped. Command and file approvals
may offer a Provider-supported session choice, but it cannot expand a later
Plan sandbox. Harness Main and Planning turns always run with Provider approval
disabled. These Agent interactions never enter the Harness confirmation queue
or create Change, workflow, authorization, Apply, Integration, I2, or E1 facts.

An active ordinary Agent turn exposes Stop and text Steer only after the snapshot
can bind the current graph's durable running Main Attempt to the process-local
Provider turn. Both use short JSON requests carrying the asserted Provider and
Attempt; the server revalidates Conversation, mode, graph, Session, and
active-turn identity before invoking the adapter. Stop requested before the
Provider turn ID exists remains pending and is sent once when that ID arrives.
Repeated requests share one submission, explicit Provider rejection permits
retry, and uncertain transport remains stopping or submitting. `turn.steer` is
optional and does not affect Provider readiness. Provider acceptance precedes
canonical `steering-sent` evidence; retries after an evidence-write failure only
repair that evidence and never resend the Provider request. Running Steer sends
only the captured trimmed text and clears it only after success; attachments,
Skills, file references, and Default/Plan selection remain for the next turn.
Stop remains a separate control and takes priority over new Steer requests.
Agent and Harness share one durable Conversation Turn FIFO for complete next-turn
input. Running text may still Steer an exact active Provider turn, while attachments
or an unavailable Steer path enqueue the full Composer snapshot. Only the selected
Conversation automatically dispatches after a reliable terminal state, and dispatch
continues through the existing Agent or Harness router. Historical pending-feedback
Timeline rows remain immutable but are not executed; the governed Harness Workflow
TaskQueue remains a separate runtime queue.

The latest failed top-level ordinary Agent turn can be retried from its terminal
row. Retry creates a new ProviderAttempt over the original canonical user input;
it never mutates or restarts the failed Attempt and does not add a second user
bubble. Preparation finishes before SSE, verifies the exact Conversation,
Provider, failed Attempt, source message, actual Default/Plan mode, managed
attachments, file references, and effective Skill evidence, then re-admits the
current Provider capabilities and sandbox. Exact client-request replay returns
the existing deterministic Attempt without another Provider call. A successful
or running later turn removes eligibility. Provider approvals and temporary
permission grants are not replayed, Composer state is untouched, and this Agent
action does not enter Harness workflow or task retry paths.

Completed top-level ordinary Agent turns can also create an independent
same-Provider Conversation branch. The source Conversation and native Session
remain unchanged; the target receives a new graph scope and Provider Session,
inherits Agent turn/model/effort and Conversation Skill preferences, and copies
canonical history only through the selected completed Turn. Copied rows receive
new identities and strip Attempt, run, Session, thread, turn, item, approval, and
Retry lineage. Fork never runs a model, sends a message, clears the shared
Composer draft, or restores/modifies project files. Schema 15 stores one bounded
idempotent operation per client request; uncertain transport remains submitting
and is not replayed after restart.

When Codex explicitly rejects `thread/resume` before accepting a new Turn, the
failed row may offer `创建恢复分支` from the last successful completed Turn. The
same Fork owner revalidates the stale binding and exact recovery anchor; the
failed input remains an unsent draft and is never resent automatically. If the
Provider can no longer fork that native Session, the UI keeps the source
Conversation and directs the user to create a new Conversation. AHO mode exposes
no Fork action and its API assertion is rejected before Provider or governance
effects.

## 1. Purpose

The AHO Workbench should feel like a Codex-style development workspace, not a traditional admin console, ticket board, or raw agent terminal.

The user-facing model is:

```text
Project
  -> Demand Conversation
    -> Main planning conversation
    -> Execution process and result summary
    -> Evidence links
    -> Apply / merge decision
```

Internally, a Workbench conversation is only the chat window and transcript. A Harness Change is created or selected only by real planning/gate/action paths, and ECL artifacts, TaskGraph, runs, validation, audit, worktrees, and decisions remain workflow truth. Those internal objects support the product; they should not be the primary user vocabulary.

Agent and AHO use one shared Conversation lifecycle surface. Active Agent
Conversations may be archived after all Turns, interactions, queue items, and
other lifecycle operations settle; a user-archived Agent Conversation may then
be restored or permanently deleted. Permanent deletion is never available from
the active list and requires a short-lived confirmation bound to the exact
lifecycle revision. Harness Conversations are archived only by the existing
Harness workflow transaction. They remain read-only in the archived group and
cannot be restored by a user, but their local conversation presentation may be
permanently deleted without deleting Change, WorkflowGraph, Run, authorization,
validation, Integration, or other governance evidence.

`ConversationLifecycleOwner` is the only user lifecycle entry point. Schema 17
records active/archive state, `agent-user` or `harness-workflow` origin, a
revision, and idempotent operation evidence. Provider Session archive/unarchive
is an optional synchronization capability: missing capability or archive
transport failure cannot undo a completed local archive, while restore fails
closed when Provider unarchive cannot be proven. Workbench never scans or
deletes Provider-private rollout files. Permanent deletion removes canonical
conversation text and unneeded session presentation records, preserves a
minimal tombstone and fork boundary, cleans only unreferenced managed
attachments, and never modifies project files or the project/mode Composer
draft.

Future Workbench direction is project conversation first: one project conversation may eventually link several related Changes when the main agent splits a broad user request. That is not the current runtime model. Current Workbench demand conversations already may create multiple active internal Changes under one project, so every selected-demand write-capable action, close/abandon action, result apply, and auto-finalize path must carry an explicit `changeId` target and avoid global active-state fallback.

The visual style is defined in `docs/UI-STYLE.md`. Static UI mockup prompts are maintained in `docs/design-prompts/workbench-ui-v1.md`.

## 2. Final Interaction Shape

The default interaction is one demand conversation:

```text
user demand
-> read-only project understanding when needed
-> main Agent forms the current Goal brief, state brief, and constraints
-> main Agent delegates planning to Plan Agent when needed
-> Plan session or real planning-agent conversation in the right Agent workspace
-> plan execution / revision handoff returns through the main conversation pending composer
-> explicit execution intent goes back to the main Agent / runtime
-> coder-agent implements and self-tests in an AHO-owned worktree
-> optional live steering while coder is running
-> validator independently checks
-> auditor independently reviews
-> bounded automatic rework when validation/audit fails
-> result summary returns to the main conversation
-> user confirms apply/merge, requests changes, or abandons
```

This is the current default code-change template, not a universal agent-order rule. Future orchestration may let the main agent clarify, split, delegate, retry, or stop for user input in a different order, while write-capable actions and high-impact transitions still remain bound to Change, evidence, and human gates.

Future Goal-driven loop UX should keep that same user surface. The center
conversation should say what visible Goal is active, what evidence changed,
and why the main Agent wants to continue, request a Plan revision, run
sequentially, fan out low-conflict worktree slices, wait, repair, or ask the
user. The right confirmation queue should show only the current real gate.
Users should not have to understand TaskRun, WorkerLease, SchedulerRun,
WorkflowRun, recovery keys, or queue internals to complete the demand. Those
terms belong in Agent orchestration graph details, evidence drawers, or
developer docs.

For the chat-only Workbench center, the primary conversation must stay clean:
real user messages, real Codex/assistant output, and compact delegation/result
activity rows only. Active Plan, clarification, and provider questions use the
single bottom Interaction Dock and never render a second timeline form. It must not expose full
planning drafts, AC/task tables, raw artifact refs, Change ids, TaskRun ids, or
WorkflowRun ids as ordinary assistant prose. Planning-agent, coder, validator,
auditor, rework, and other real model-Agent details belong in the right `Agent`
workspace and graph node details. Evidence should be reachable through the
right `Agent` / `确认` / `诊断` tools, compact activity row expansion, or the
Agent-only relation graph. The graph remains a read-only projection opened
from the top tool button; it explains real Agent delegation and results but
cannot execute workflow actions.

The right rail separates interaction surfaces by responsibility. The center
conversation is the main Agent surface, so the right `Agent` workspace shows
only provider-owned Plan sessions and real child-agent surfaces such as
planning-agent, coder, auditor, rework, Maintenance, or Evolution. It
shows transcript / process rows, plan items, compact runtime activity,
output summaries, and evidence refs for that selected surface. User-blocking
Plan handoff and provider question cards belong in the main composer pending
stack, not duplicated in the right Agent workspace. `确认` shows only real Harness
gates such as source apply, landing/close, Scheduler/IntegrationCheck,
remote/PR/merge, abandon/request-changes, or Harness evolution. Provider-native
Plan sessions are runtime conversation surfaces: they show plan text, question
conversation, and free user feedback, but they do not create a Harness Change, write a
planning bundle, or expose a Workbench planning action. The workspace is a
projection and scoped interaction surface, not workflow truth or a permission
system.

Provider runtime events are projected by ownership, not by parsing visible
assistant text. Ordinary main-agent chat must not start planning-agent by
keyword, fixed phrase, or Workbench-side guess. A child-agent or plan workspace
appears only when a real Harness action or provider runtime event carries a
clear owner such as role/session/thread/turn/item identifiers. Explicit owner
metadata wins; a single active turn may be used as a bounded fallback; ambiguous
multi-turn events must stay unassigned rather than being pushed into the main
conversation or the wrong Agent workspace.

Complex planning uses a real Planning child spawned by Main Agent. Main Agent
sends the concrete user goal, relevant evidence, and Runtime-assigned proposal
workspace; the child writes the proposal files and its provider thread appears
in the Plan Agent workspace. Provider plan deltas and user-input requests are
runtime interaction events, not Harness gates or canonical workflow truth.
Native Plan Mode and `<proposed_plan>` replay are historical or diagnostic
fallback evidence, not the current planning owner.

The plan body itself is written by the Agent/runtime path. Workbench must not
turn a raw user request into invented goals, acceptance criteria, tasks, or a
workflow plan by rule. AHO can project provider events and preserve execution
boundaries, but it must not synthesize business planning artifacts from a chat
message or Plan Mode transcript. If the plan is incomplete, the Plan session
continues the conversation instead of showing a fake plan or hidden generated
bundle.

Plan handoff is a main-Agent intent surface. `Execute` and `revise plan`
feedback go first to the main Agent, which checks the current Goal brief,
project evidence, and Harness constraints before deciding whether to ask Plan
Agent for revision or move a confirmed WorkflowPlan into runtime execution.
The handoff must not directly call workflow actions, create a Change, grant
permissions, or send revision feedback straight to Plan Agent without the main
Agent review step.

OpenSpec is the reference for the planning artifact flow. Proposal, spec,
design, tasks, and AC are artifacts produced by an Agent following project
rules, skills, and repository docs. Accepted artifacts remain workflow truth;
the real Planning child's final canonical assistant item is the single visible
Plan body. Main shows only a compact reference, while the full body remains in
the child transcript and right resource tab. In normal conversation
mode, the Agent enters or updates Harness state by using the project rules and
tools; Workbench does not provide a product planning button, `latest-bundle`,
or hidden bundle promotion path.

Open Dynamic Workflows is the algorithm reference for deterministic workflow-as-artifact mechanics, not for the Workbench product surface. The AHO target is recorded in `docs/design-docs/harness-workflow-runtime-target.md`: Workbench should submit user intent and show progress/pending gates, while `workflow-runtime` owns scheduling. Phase 7H used only the proposal lesson: if a broad demand needs decomposition, the center conversation can show the main agent's DecompositionPlan in user language. Phase 7I adds a separate `DecompositionReadinessManifest` check after confirmation. Phase 7J uses that verdict as a gate: `ready-for-single-change` may expose `code.run`, while `ready-for-sequential-taskqueue-proposal` exposes TaskQueueProposal generation. Phase 7L adds a separate `WorkflowGraphPlan` compile action before confirmed queue start; graph compile is evidence and execution input, not execution. Phase 7K adds typed WorkflowRun progress recovery for that confirmed sequential queue. The current `sequential-v1` path is compatibility, not the final user-surface architecture. Workbench must not own ready-set, barrier, pipeline, scheduler-wave, or leaf-dispatch decisions, and must not expose ODWF-style JavaScript scripts as product UI.

Phase 6J adds bounded background execution across independent demand conversations. The user still works in one selected demand conversation at a time, but the project can show a small background summary such as `2 个处理中，1 个等待处理`. Background demand results must return to their own demand conversations; they must not appear in the selected conversation.

Phase 6K adds scoped apply readiness for those concurrent results. When the selected demand's result is still based on the current project state, the Inspector may offer `应用到项目`. When the project changed after that result was produced, the main conversation should say `项目已变化，需要重新处理这个结果` and offer a same-demand fresh rework attempt. Dirty local source state should offer status refresh or evidence, not automatic coder rework.

Phase 6L narrows the right pane into a confirmation queue. The center conversation explains what happened and summarizes tool results; the right pane only contains items that require human confirmation, such as confirming execution, checking compatibility for multiple ready results, applying a checked result set, requesting changes, or abandoning a result. Running state, raw evidence, worker details, maintenance logs, and technical diagnostics stay in details/evidence views.

Phase 6M keeps that interaction model. If a local compatibility check fails for a combined result, the parent conversation should explain that AHO is trying one bounded integration-layer repair. If the repaired result passes aggregate validation/audit, the right queue returns to `应用到项目`. If the repair fails or the budget is exhausted, the right queue shows only user decisions such as `要求修改`, `放弃`, and `查看证据`.

Phase 6N adds a local landing readiness step after the user has already applied a result to the local source root. The parent conversation should say that AHO is doing a `提交/PR 前检查`, then summarize the landing package and merge-reviewer verdict. The right pane may show a landing readiness item and evidence links, but it must not expose fake PR, push, remote merge queue, or landing queue actions.

Phase 6O adds the first real remote handoff. If the merge-reviewer verdict is ready and GitHub CLI capability is actually available, the right confirmation queue may show `创建 PR 草稿`. If remote, `gh`, auth, or permission is missing, the right pane should show configuration guidance instead of a fake create button. The center conversation must explain that a Draft PR is not merge/land/auto-merge and that future PR feedback handling is a later phase.

Phase 6P adds the first remote feedback loop. The parent conversation should explain what GitHub PR feedback/checks say, then describe the main agent decision: no action, optional user judgment, same-demand rework, provider unavailable, or stale PR. The right confirmation queue may show `检查 PR 反馈`, `根据 PR 反馈修改`, or `更新 PR 草稿`, but only when those actions have real backend paths. Updating a Draft PR is still only a branch/body update after a fresh landing review and user confirmation; it must not expose merge, land, ready-for-review, comment reply, or review-thread resolution controls.

Phase 6Q adds the ready-for-review handoff. The parent conversation should explain that the Draft PR has no actionable feedback or failed checks and can be submitted for human review. The right confirmation queue may show exactly one primary action, `提交人工评审`, only when provider readiness, draft state, feedback classification, and checks allow it. Submitting for review is not merge/land; the UI must not show reviewer assignment, comment resolution, auto-merge, merge queue, or landing controls.

Phase 6R adds thread-aware PR review feedback handling after the PR is in human review. The parent conversation should summarize reviews, checks, top-level comments, inline review comments, and any user-provided stance in normal language. Actionable feedback should become one same-demand rework context, not one agent per comment. Comments that need explanation should create an explicit reply draft; `回复评审` and `标记已处理` only appear in the confirmation queue when a real provider action exists. This stage still must not show merge, land, request-reviewer, auto-merge, or push-main controls.

Phase 6S adds background demand memory consolidation and doc drift guardrails. Terminal demands may generate closeouts, append maintenance ledger entries, refresh generated maintenance indexes/cache, and trigger a five-change maintenance review. These artifacts are not current-demand decisions. The parent conversation may show only light notices such as `后台已整理本次需求记忆` or `后台维护发现文档漂移候选，可在项目维护中查看`. The right confirmation queue must not show maintenance candidates unless a later human-gated product flow explicitly promotes a maintenance proposal.

Phase 6T adds the first remote landing action. The parent conversation should explain that PR readiness, reviews, and checks are evidence, while `合并 PR` is a high-impact user-confirmed action. The right confirmation queue may show `合并 PR` only for an explicit ready PR target. After success, the center conversation should say the PR was merged remotely and the local checkout was not automatically synced. Merge failure should show provider evidence and next status only; it must not show fake automatic repair, merge queue, branch cleanup, push-main, or local sync controls.

Phase 6U adds post-merge reconcile and optional cleanup. After a successful remote merge, the parent conversation should explain the remote PR state, current local branch, local dirty/clean state, whether fast-forward sync is safe, and whether the remote PR head branch can be cleaned up. The right confirmation queue may show `同步本地项目` only for a clean checkout already on the PR base branch with a fast-forward update available. It may show `清理远端 PR 分支` only when the remote PR head branch still exists and is safe to delete. It must not show checkout, stash, reset, rebase, implicit pull, push-main, local branch delete, auto-merge, or merge queue controls.

Phase 6V adds a project-level remote landing queue for multiple ready PRs. The parent conversation should explain how many PRs are ready, which PR is recommended next, and why other PRs need feedback/check handling or a later refresh. The right confirmation queue may show exactly one primary `合并 PR` action for the selected refreshed candidate, while other PRs remain folded as background queue items. After one merge succeeds, the parent conversation should explain that remaining PRs were refreshed before another confirmation. It must not show `合并全部`, unattended auto-merge, push-main, branch-protection bypass, local sync batch, or provider raw JSON.

Phase 6W introduced a read-only demand run graph. The current user-facing `Agent 编排图` supersedes that broad graph and renders as a center-workspace canvas: it contains only real provider-backed model Agents and their parent/child relations. Main, Plan, Coder, Rework, Auditor, Spec-test, Maintenance, Evolution, and Scorer appear only after a real thread/session/run exists. Validator, IntegrationCheck, Workflow stages, worktrees, apply/commit/close, evidence, leases, and expected-but-not-started roles never appear in this graph; they remain Runtime or diagnostic facts. Clicking Main returns the center workspace to the Main conversation. Clicking a child keeps the canvas visible and opens that exact Agent thread in the right workspace. The graph remains a read-only projection and never executes workflow actions.

Phase 6Y introduced a controlled `delegateTask` contract and process metadata. Phase 7A supersedes the default rendering rule: the `对话` tab no longer turns AHO role results, validation/audit evidence, PR/landing summaries, policy pass records, or maintenance notices into synthetic conversation prose. Those records remain builder inputs for graph/details/confirmation surfaces. The default conversation only renders real Codex runtime or `codex exec` replay cells.

Phase 6Z changed foreground role execution from a fixed backend role workflow into main-agent tool orchestration. The current transcript does not synthesize ToolPolicyGate, validation, integration, or other Runtime steps into conversational process rows. It shows provider-visible Main text, visible reasoning summaries, actual tool/file/search calls, and actual child-Agent calls. Runtime-only activity remains in diagnostics and evidence views.

Phase 7A changes the default transcript input from legacy block/items to `ParentAgentTranscriptCell[]`. The conversation tab must prioritize real Codex runtime cells: app-server notifications, assistant deltas, tool/item events, and `codex exec` JSONL/final-message replay. AHO orchestration, role returns, validation/audit, PR/landing, policy, and maintenance events must not synthesize main conversation body text. They belong in the Agent orchestration graph, node details, the right confirmation queue, or evidence drawers unless they are explicitly present in the Codex-visible runtime/replay stream. `turn/completed` updates state only; it must not create `处理完成`, `执行结果`, or equivalent prose. `codex exec` cells are replay-style, not live streaming.

Phase 7B tightens the renderer boundary. `ParentAgentTranscriptCell` rows are the only default conversation rendering source; frontend code must not append pending clarifications, live-turn fallback bubbles, planning/result cards, role pipeline rows, or maintenance cards directly into the `对话` tab. Command, MCP/tool, and file-change rows show only compact summaries such as `已运行 6 条命令`, `调用 MCP 工具`, or `文件已变更`; command text, stdout/stderr, cwd, exit code, tool arguments/results, diff previews, raw JSONL, and artifact paths belong in the row detail panel or graph/evidence views. Expanded tool details preserve the complete canonical content in one manually opened viewport capped near 320px with internal vertical and horizontal scrolling; they do not grow the conversation by the full output height. Legacy thread items, role summaries, and result-review cards are builder inputs or detail views only.

The current realtime contract uses one normalized provider event path for Main and every real child/background Agent. Provider events update stable timeline identities in place: a running turn shows exactly one activity row at the current turn tail, such as `正在思考` with elapsed time, switches to `正在回复` on the first real text delta, and renders the provider delta without a fake typing animation. Completion changes the same timeline identity into one stable tail boundary such as `已完成 · 24 秒`; successful connection and successful reconnect attempts fold into current status, while terminal connection failure remains explicit. Command, tool, file-change, child-Agent, and provider-visible reasoning-summary items use run/thread/item identity and remain persisted conversation cells after completion and browser refresh, with details collapsed by default. A folded reasoning row includes its short visible summary rather than only a generic label, and in-progress reasoning is not duplicated beside the current activity row. The lazy transcript projection calibrates matching timeline cells and only then prunes the transport overlay, so component identity, manual expansion, scroll intent, and final messages remain stable. Hidden chain-of-thought is never projected.

The right Agent workspace uses one ephemeral browser-style resource-tab owner.
Agent targets bind to stable provider-backed `agentSurfaceId`, Plan targets to
immutable `documentId`, and Markdown/TXT targets to normalized project-relative
paths. Same-role Agents remain separate; opening the same resource selects its
existing tab. Agent tabs preserve their transcript and composer, while Plan and
file tabs are read-only. Events never auto-open or focus the workspace. Closing
a tab closes only the view and never interrupts a run. Conversation changes
retire Agent/Plan tabs but preserve project-file tabs; project changes clear all.

Phase 7C splits Workbench loading. `getWorkbenchSnapshot()` is the first-screen shell for project/memory/repo, topic/workpad summaries, selected-demand light summary, confirmation queue, counters, refs, warnings, roles, and Harness gaps. Transcript, run graph, workpad/detail, evidence bundle, maintenance summary, and landing queue data load only when the user opens the relevant tab/detail. Live actions invalidate those loader caches. Cross-demand and demand-scoped actions must carry their target `changeId` and explicit target ids; the server rejects missing, stale, or forged high-impact targets against current derived state before executing.

Phase 7F keeps the same user-facing default code-change loop, but the backend role order is now selected by a deterministic main-agent decision engine. This engine is current compatibility; the target is to show the same progress as a `default-code-change-workflow` run owned by the future `HarnessWorkflowRunEngine`. The Workbench may still show process rows for coder, validator, auditor, and bounded rework, but those rows are projections over `AgentTaskResult`, validation/audit evidence, boundary audits, and orchestration decisions. Validation or audit failure can start one automatic rework attempt; after that, the user should see a clear needs-input/result state rather than an unbounded invisible repair loop.

WorkflowRun recovery should appear as ordinary progress recovery, not as a trust decision. The Workbench may say that previously completed scoped work was reused after resume only when current Change, WorkflowGraphPlan, TaskQueueProposal snapshot, readiness manifest snapshot, accepted artifacts, source state, policy profile, and runtime capability still match. If any recovery key is stale, the UI explains that the workflow is blocked and needs user input. Reused progress remains evidence and does not skip validation, audit, or human apply/merge decisions. For sequential readiness the next-action chain is: generate TaskQueueProposal, compile WorkflowGraphPlan, confirm TaskQueue start, then resume/continue only with matching `workflowRunId + queueRunId`.

Phase 7M requires Workbench actions in that chain to preserve the full typed scope. TaskQueue resume and confirm-start payloads include proposal, graph, readiness, decomposition, workflow, and queue ids where applicable; the UI does not treat those ids as trust, but it must carry them so stale-target revalidation and audit evidence match exactly what the user confirmed.

The historical Phase 7N-8Q splits preserved Workbench behavior while moving server, read-model, frontend, runtime, and action logic into owned modules. The later owner convergence completed that work: the `chat.ts` and `manager.ts` compatibility facades are deleted, exact Conversation/Timeline/Workflow owners are imported directly, and only canonical Timeline Delivery publishes persisted envelopes. Workbench HTTP, SSE, actions, projections, provider calls, and UI behavior remain unchanged.

Phase 8S adds a Workbench affordance for scheduler readiness only. When a selected demand is a parallel TaskGraph candidate with concrete scopes, Workbench may show "编译 Scheduler Contract" and a SchedulerContract summary. It must not show parallel start, queue, or run controls in this phase, and full contract details remain lazy-loaded evidence.

Phase 8Y extends that Workbench affordance with "生成调度预演" after a SchedulerContract exists. The UI may show dry-run summary fields such as wave count, estimated max wave width, blocked count, and prerequisite warnings, with full dry-run detail lazy-loaded. It still must not show parallel start, run, queue, worker-slot, lease, or scheduler controls.

Phase 8Z extends the same affordance with "编译 Worker Session Plan" after a SchedulerDispatchDryRun exists. The UI may show planned worker count, stage count, warning count, and recovery-key coverage, with full plan detail lazy-loaded. It still must not show parallel start, run, queue, worker-slot, lease, or scheduler controls.

Phase 9A extends the scheduler pre-execution affordance with "编译 Claim / Reconcile Plan" after a SchedulerWorkerSessionPlan exists. The UI may show wave count, claim intent count, max planned wave width, blocked count, and recovery coverage, with full plan detail lazy-loaded. It still must not show parallel start, run, queue, worker-slot, lease allocation, or scheduler controls.

Phase 9B extends the scheduler pre-execution affordance with "检查 Launch Preflight" after a SchedulerClaimReconcilePlan exists. The UI may show status, claim intent count, planned slot demand, blocked count, and human-gate requirement, with full preflight detail lazy-loaded. It still must not show parallel start, run, queue, worker-slot, lease allocation, ToolPolicy pre-authorization, or scheduler controls.

Phase 9C extends the scheduler pre-execution affordance with "准备 SchedulerRun" after a checked SchedulerLaunchPreflight exists. The UI may show SchedulerRun status, human-confirmed launch intent, claim intent count, planned slot demand, journal event count, and future gate requirements, with full SchedulerRun detail lazy-loaded. It still must not show parallel start, run, queue, worker-slot, lease allocation, WorkerSession, RuntimeWorkspace, EventSource, ToolPolicy pre-authorization, or scheduler controls.

Phase 9D extends the scheduler affordance with "初始化 Scheduler Runtime 壳" after a prepared SchedulerRun exists. The UI may show runtime shell status, wave count, claim intent count, blocked count, and last reconcile time, and may show "生成 Reconcile Snapshot" after initialization. Full runtime state and reconcile snapshot detail remain lazy-loaded. It still must not show parallel start, worker start, queue, slot, lease, WorkerSession, RuntimeWorkspace, EventSource, ToolPolicy pre-authorization, or scheduler execution controls.

Phase 9E extends the scheduler affordance with "预占 Runtime Claims" after a matching reconcile snapshot exists. The UI may show reservation status, reserved count, blocked count, wave index, source lock count, and superseded reservation id, with full reservation detail lazy-loaded. It still must not show parallel start, worker start, queue, slot, lease, WorkerSession, RuntimeWorkspace, EventSource, ToolPolicy pre-authorization, or scheduler execution controls.

Phase 9F collapses the ordinary scheduler confirmation surface into two user-facing Harness stage gates. After scheduler readiness, the right side should primarily show `准备并行执行计划`; this lets the main Agent fill the internal scheduler evidence chain and explain the plan in the main conversation. After the plan is prepared, the right side should show `确认启动这个并行执行计划`; this records the user's overall launch intent and produces a plain-language launch brief. The right side confirmation queue is a Harness phase gate, not a generic tool permission prompt, and ordinary users should not have to confirm internal checkpoints such as SchedulerRun preparation, runtime shell initialization, reconcile snapshots, or claim reservation one-by-one. Those internal artifacts remain available as lazy evidence/detail and for stale revalidation, audit, and recovery. Phase 9F still must not show parallel start, worker start, queue, slot, lease, WorkerSession, RuntimeWorkspace, EventSource, ToolPolicy pre-authorization, or scheduler execution controls.

Phase 9G adds the next user-facing Harness gate after launch confirmation: `启动第一个 worker`. This is intentionally singular. The Workbench may show which scheduler node/unit and coder stage was selected, plus the resulting TaskRun, WorkerLease, worktree, code run, and runtime-continuity status. It must not expose internal checkpoint buttons as the ordinary flow, must not show "start all" or full parallel controls, and must not imply that validation, audit, bounded rework, later waves, a scheduler loop, or slot allocator have started.

Phase 9H adds the next singular user-facing Harness gate after the first worker starts: `检查第一个 worker 结果`. The action reconciles the selected WorkerStart and its code Run evidence into scheduler-owned worker result evidence. The Workbench shows the node/unit, coder stage, TaskRun, WorkerLease, worktree, code run, and result status summary. Once terminal result evidence exists, the ordinary confirmation queue stops showing the same reconcile button. The UI still must not show validation, audit, bounded rework, "start next worker", "start wave", slot, lease, queue, or full parallel controls.

Phase 9I adds the next singular user-facing Harness gate after an evidence-ready first worker result: `验证第一个 worker 结果`. The action runs exactly one scoped Validation path against the worktree created by that first scheduler coder worker, then writes scheduler-owned validation evidence. Passed validation is still not task completion; the UI should show that audit is a later gate. Failed validation blocks the current scheduler worker path. The UI still must not show audit, bounded rework, "start next worker", "start wave", slot, lease, queue, apply, merge, or full parallel controls.

Phase 9J adds the next singular user-facing Harness gate after passed first-worker validation: `审计第一个 worker 结果`. The action runs exactly one scoped Audit path against the same worker worktree and exact validation run, then writes scheduler-owned audit evidence. Approved audit can complete that TaskRun; blocked/failed audit blocks only the current scheduler worker path. The UI still must not show bounded rework, "start next worker", "start wave", slot, lease, queue, apply, merge, or full parallel controls.

Phase 9K adds a non-executing Harness gate after first-worker validation failed or audit blocked/failed: `生成第一个 worker rework 计划`. The action writes scheduler-owned rework-plan evidence and shows a short summary of the blocking source, target worker/worktree intent, and required future gate. The UI must not show "启动 rework", next-worker, whole-wave, scheduler loop, slot, lease, apply, merge, or full parallel controls from this plan.

Phase 9L adds the next singular Harness gate after a scheduler rework plan exists: `启动第一个 worker rework`. The action starts exactly one scoped `rework-coder` on the original worker worktree and shows the rework TaskRun, WorkerLease, worktree, and code run summary. The UI still must not show rework result reconcile, validation, audit, next-worker, whole-wave, scheduler loop, slot allocator, IntegrationCheck, apply, merge, or full parallel controls.

Phase 9M adds the next singular Harness gate after that rework start exists: `检查第一个 worker rework 结果`. The action reads the rework code run, rework TaskRun, rework WorkerLease, and worktree evidence and shows whether the rework is still running, `evidence-ready`, or failed. The UI still must not show rework validation, rework audit, next-worker, whole-wave, scheduler loop, slot allocator, IntegrationCheck, apply, merge, or full parallel controls.

Phase 9N adds the next singular Harness gate after an evidence-ready rework result exists: `验证第一个 worker rework 结果`. The action validates the same reused worktree and shows scheduler-owned rework validation evidence. The UI still must not show rework audit, another rework, next-worker, whole-wave, scheduler loop, slot allocator, IntegrationCheck, apply, merge, or full parallel controls.

Phase 9O adds the next singular Harness gate after a passed rework validation exists: `审计第一个 worker rework 结果`. The action audits the same reused worktree, binds the audit to the exact rework validation run, and shows scheduler-owned rework audit evidence. The UI still must not show another rework, next-worker, whole-wave, scheduler loop, slot allocator, IntegrationCheck, apply, merge, or full parallel controls.

Phase 9P adds the next bridge gate after audit-approved scheduler worker output exists: `生成 scheduler integration 候选`. The action compiles `SchedulerIntegrationCandidate` evidence and shows ready target count, blocked output count, and ready worktree ids. If fewer than two ready targets exist, Workbench shows a waiting summary only. The UI still must not show IntegrationCheck, apply, merge, next-worker, whole-wave, scheduler loop, slot allocator, or full parallel controls in Phase 9P.

Phase 9Q adds the next bridge gate after at least two scheduler integration candidate targets are ready: `运行 scheduler IntegrationCheck`. The action delegates to the existing IntegrationCheck confirmation path with explicit target worktree ids and shows the resulting handoff evidence. It does not expose source-root apply/discard as scheduler actions, and it must not show next-worker, whole-wave, scheduler loop, slot allocator, landing, PR, merge, or full parallel controls.

Phase 9R adds the next bridge gate only after the existing IntegrationCheck has left `passed`: `记录 scheduler integration 结果`. When IntegrationCheck is still `passed`, Workbench continues to rely on the existing apply/discard confirmation queue and shows scheduler outcome as waiting. When IntegrationCheck becomes `applied`, `discarded`, or a blocked terminal status, Workbench records a scheduler-owned outcome summary and lazy evidence projection. This UI is an evidence mirror, not a second apply/discard surface.

Phase 9S adds the next worker gate only when existing scheduler worker paths are terminal and the latest integration candidate still needs another ready output: `启动下一个 worker`. Workbench must not expose internal scheduler checkpoints or whole-wave controls; the action starts at most one additional coder worker and then returns to the same result/validation/audit/rework gate sequence. Multiple scheduler worker paths must remain visible enough that a newer worker does not hide an unresolved older one.

Phase 9T repairs the Workbench scheduler surface after `start-next`: result, validation, audit, and rework confirmations should describe the selected current worker path rather than a first-worker singleton. When later approved worker outputs are not covered by the latest `SchedulerIntegrationCandidate`, Workbench must offer candidate refresh before starting another worker or running IntegrationCheck.

Phase 9U verifies that the Workbench can carry a second scheduler worker through the same current-worker surface. After the first approved worker output produces a waiting scheduler integration candidate, Workbench may show `启动下一个 worker`; after that worker is started, ordinary result, validation, audit, and rework labels must describe the current worker path, not a first-worker singleton. Once two approved outputs are available, the primary flow must refresh `SchedulerIntegrationCandidate` and only then expose existing scheduler IntegrationCheck handoff. The UI still must not show whole-wave dispatch, scheduler loop, slot allocator, start-all, apply, landing, PR, merge, child Change, or full parallel executor controls.

Phase 9V verifies the handoff after IntegrationCheck. When a scheduler handoff produces a passed IntegrationCheck, the right confirmation queue must still show the existing `确认应用到项目` / `放弃` IntegrationCheck actions. Scheduler outcome reconcile is a follow-up evidence action after that existing gate changes IntegrationCheck state; it is not a scheduler-owned apply/discard affordance and must preserve explicit target ids in action payloads and decision/audit scope.

Phase 9W keeps that user surface unchanged while adding SchedulerRun event/projection evidence for the integration bridge. The Workbench may show the candidate/handoff/outcome evidence trail in scheduler details, but it must not expose a new scheduler apply/discard button or make internal integration events look like user-required stages.

Phase 9X adds the final scheduler run status surface after terminal scheduler integration outcome: `记录 SchedulerRun 完成状态`. Once completion exists, Workbench should show a clear terminal scheduler summary and stop presenting scheduler start-next, IntegrationCheck handoff, or outcome reconcile as executable actions. Existing IntegrationCheck apply/discard confirmation remains the only user-facing source mutation gate while IntegrationCheck is still `passed`.

Phase 9Y verifies this Workbench surface end to end. The right-side confirmation queue must present only the action a user can understand at each stage: existing `确认应用到项目` / `放弃组合结果` while IntegrationCheck is `passed`, scheduler outcome only after apply/discard terminal state, and no executable scheduler follow-up once SchedulerRunCompletion exists. Internal scheduler artifact ids may remain in evidence/detail views but must not become ordinary primary user workflow.

Phase 9Z adds one more user-facing terminal option for the pre-IntegrationCheck dead end: when the scheduler candidate is blocked or exhausted, ready targets are still fewer than two, and there is no legal next-worker path, Workbench may show `结束本次 scheduler run`. Confirming it records SchedulerRun closeout evidence and a plain-language summary. It must not show IntegrationCheck/apply/merge controls, must not start another worker, and must not expose internal checkpoint buttons as the normal user workflow.

Phase 10A consolidates the ordinary scheduler execution surface after the Phase 9G-9Z execution slices. The right confirmation queue should present a small set of user-facing stage labels such as continuing the current scheduler plan, checking current evidence, handling a current blockage, checking combined results, completing the execution record, or marking the run unable to continue. These labels are presentation and decision clarity only: each confirmation still maps to one existing scoped scheduler action, preserves the full action payload and decision/audit target ids, and goes through ToolPolicyGate plus stale-target revalidation. The UI must not turn this consolidation into one-click start-all, automatic validation/audit/rework, start-next loops, whole-wave dispatch, slot allocation, scheduler-owned apply/discard, child Changes, or full parallel execution.

Long-running Goal interaction now stays in the ordinary Main conversation. The Main Agent may explain
the current objective, accepted plan, evidence, blockage, and next concrete gate, but Workbench must not
recreate the retired GoalLoop packet/controller/actions or infer execution from that explanation.
The existing right-side confirmation remains the only user-facing executable transition and carries
its exact targets, stale revalidation, ToolPolicy audit, and human confirmation.
The Workbench snapshot, transcript, and orchestration graph are projections, not workflow truth. The snapshot is a UI shell, the transcript must not show mechanical labels such as `AI 回复` or `执行结果`, and derived tool-result summaries must not pretend to be exact historical LLM text. The orchestration graph must not become the source of scheduling truth, must not create fake SubAgent chats, must not execute workflow actions, and must not move maintenance candidates into the right confirmation queue. The right side stays limited to human gates such as confirming execution, applying, checking compatibility, creating/updating PRs, submitting review, replying to review, merging, syncing, cleanup, requesting changes, or abandoning work.

Runtime boundary issues are explanation/evidence events, not confirmation queue items. When ToolPolicyGate denies a request or PostRunBoundaryAudit finds a role wrote outside its allowed scope, the main conversation should explain the user-impact in plain language and link evidence. The right queue should only show a user decision if there is a real next action such as requesting changes or abandoning the result.

For multiple ready demand results, the parent agent may suggest a local compatibility check before applying them together. The user confirms `检查兼容性`; AHO runs the check in a temporary integration worktree and returns the outcome as a tool result. A passed check creates a separate `确认应用到项目` item. A failed check creates request-changes/discard/evidence options. The check itself never modifies the source root.

## 3. Layout

```text
left sidebar                         center tabs                                  right confirmation queue
Global entries                       对话                                        Current human-gate item
Project folders                      Agent 编排图                                Evidence links
Nested demand conversations          Composer / Interaction Dock                 Apply / merge decision
Pinned settings                                                                  Scoped feedback
```

### Left Sidebar

- Top global entries: new conversation, search, and only real available plugin/skill surfaces.
- Middle project folders: each project row expands to demand conversations under that project.
- Demand rows may show user-facing statuses such as `处理中`, `等待处理`, `等你确认`, `需要修改`, and `已完成`.
- Project menu: repository status, memory status, initialize Harness when needed, refresh project, create/add project actions.
- Bottom pinned settings.

The sidebar should not expose `Topic`, `Workpad`, `Change`, `TaskRun`, `WorkerLease`, `blocked`, or queue terminology as primary labels.
It also should not expose worker-slot, claim, or DemandWorker terminology; those are internal runtime details.

### Center

The center surface has two tabs:

- `对话`: the main parent-agent transcript.
- `Agent 编排图`: a lazily loaded read-only relationship graph containing only real model Agents for the selected demand.

The conversation tab should show:

- user requests and follow-up feedback;
- visible Codex/main-agent assistant markdown exactly as runtime/replay recorded it;
- compact Codex command/tool/file-change/review-mode rows when runtime/replay recorded them;
- replay-style rows for `codex exec` JSONL/final-message events;
- errors only when the runtime/replay or AHO boundary check exposes a user-impacting failure.

The conversation tab should not synthesize planning drafts, role returns, validation/audit summaries, PR/landing summaries, maintenance notices, or generic completion text from AHO workflow state. Real child calls may appear as compact navigable rows, while Runtime-only results belong in diagnostics, the right confirmation queue, or evidence views unless they are literally present in the provider transcript.

The ordinary Composer and `ConversationInteractionDock` occupy the same bottom
slot and are mutually exclusive. The Dock shows one current native question at
a time with compact options, an inline custom-answer row, skip, and close.
Close/Escape and skip settle without interrupting the provider; the separate
square stop control is the only turn-interrupt action. When Agent graph center
is open, the ordinary Composer is hidden; a pending Dock remains available so
the graph cannot strand a real user-input request.

A native child lifecycle row is inserted at the provider event position and
updated in place from running through terminal state. Clicking it opens the
exact provider-qualified child surface in the right browser-style tabs. The
Agent Relation Graph is a server projection and shows the same child as soon as
native spawn is known; React does not synthesize nodes, names, numbering, or
edges from transcript text.

Agent Loop is no longer a default center tab. It remains available from graph node details or evidence details. It may show run ids, raw artifacts, logs, and internal runtime terminology because it is not the primary user decision surface.

When multiple demand conversations run concurrently, the center surface remains scoped to the selected demand. It may show a project-level background count, but it must not stream another demand's role results into the current conversation.

### Right Inspector

The right inspector is scoped to the selected demand conversation. It should summarize:

- the current plan or result;
- relevant role/result cards;
- strongest evidence;
- scoped feedback target;
- final apply/merge decision when available.

It is not a global approval list. It should not ask the user to accept every validation/audit result. Intermediate role output is evidence. The user decides whether to execute a plan, request changes, abandon a demand, or apply/merge a final result.

Maintenance closeouts, fixed evolution windows, doc budget reports, scorer output, raw ledgers, and background logs do not belong in the right inspector. The work surface shows only the background Agent role, status, stage, and update time; clicking the Agent opens its real thread/evidence details. Maintenance never creates a confirmation card and does not block conversation, planning, worktree execution, or source transitions. Other Agents may also update project docs; each background task re-reads current state and reconciles evidence-backed drift.

## 4. User-Facing Language Rules

Primary Workbench surfaces should use:

- `项目`
- `需求对话`
- `方案`
- `执行`
- `结果`
- `证据`
- `应用` / `合并`
- `需要修改`
- `处理中`
- `已完成`
- `稍后处理`
- Agent Composer 中的 `Default` / `Plan`

Primary Workbench surfaces should not use:

- `Topic`
- `Workpad`
- `Change`
- `TaskRun`
- `WorkerLease`
- `blocked`
- `audit-blocked`
- `queue blocked`
- `Approval Inbox`
- Harness 主对话中的 `Plan mode`

Internal terms may appear in developer docs, tests, APIs, storage, and Agent Loop / raw evidence contexts.

## 5. Core UX Rules

- A developer should understand the current demand, next required decision, and strongest evidence without opening raw files first.
- Harness planning happens in the `plan-session` / Plan Agent workspace or in a
  real provider-owned child-agent workspace; the Harness main conversation keeps
  the parent Agent narrative and delegation/result process rows. This is
  separate from the ordinary Agent Composer's read-only `Plan` turn mode.
- Command process rows use deterministic running/completed/failed wording and
  the same normal font weight. Failure is conveyed with restrained status color
  and iconography, while details remain manually expanded in the bounded
  scrolling viewport.
- If Codex app-server is active, running input is sent to the current planning/coder turn. If fallback is active, the UI must say the input is recorded for the next turn.
- A user confirming execution only agrees to implement the current plan; final source apply/merge still needs explicit confirmation.
- A user confirming a scheduler stage agrees to one described Harness transition, not to an unbounded autonomous loop; the retired GoalLoop surface is not a current confirmation path.
- Result review actions must be scoped to the selected demand result. A background demand result must not expose apply/discard decisions in the current conversation.
- Source drift is explained as `项目已变化，需要重新处理这个结果`, not as a raw git gate error.
- Coder self-test is allowed inside the assigned worktree, but official validation/audit remain independent evidence.
- Validation/audit failures should first trigger bounded automatic rework. Interrupt the user only for ambiguity, product tradeoff conflicts, environment problems, exhausted rework budget, or no real repair path.
- Archived demand conversations are read-only. Implementation follow-up creates a linked follow-up conversation.
- Agent activity visualization is an Agent-only Office projection over real
  provider lineage and Agent surfaces; it is not workflow truth. Exact Agent
  navigation remains bound to the canonical Agent surface.
- Office handoffs use calibration V5: one shared spatial route determines both
  directions, while each departure, route, interaction, return, and seating
  action keeps its own mirror value. Mobile actors render above chairs; seated
  actors render behind chairs. The production activity compiler, rather than
  the renderer, owns those posture transitions.
- Parallel worktree slices are useful only when the main Agent can explain low conflict. High-conflict slices wait, run sequentially, or enter a fix loop.

## 6. Objects The GUI May Surface

| User-facing object | Internal binding |
| --- | --- |
| Project | Managed project registry entry |
| Demand Conversation | Topic/Change/Workpad binding and interaction log |
| Plan Session | Real parent-spawned Planning child and provider thread before implementation |
| Execution Result | Role pipeline run summaries and evidence |
| Evidence | Run artifacts, validation, audit, worktree state, decisions |
| Apply / Merge Decision | Human-gated source transition |
| Agent Loop | Technical evidence and replay surface |

## 7. Deferred Scope

The current Workbench does not implement:

- remote projects;
- full plugin marketplace;
- cross-project full-text search;
- parallel worker pool;
- dependency/conflict scheduler;
- always-on integration workspace beyond the existing scoped IntegrationCheck path;
- merge queue;

## 8. Phase History

- Phase 5R made Workbench the default read model for a selected internal Change.
- Phase 5S added deterministic intake and clarification before Spec.
- Phase 5T through 5W added TaskGraph, TaskRun/WorkerLease, and local sequential queue projections.
- Phase 5X aligned right-side decisions with current blockers and evidence.
- Phase 5Y defined Coding Work Package as the normal coder-agent assignment grain.
- Phase 5Z added multi-demand projection and memory isolation.
- Phase 6A simplified user decisions and automatic finalization.
- Phase 6B added main planning-agent artifacts and the local role pipeline.
- Phase 6C made the left sidebar project-folder / demand-conversation based.
- Phase 6D aligned docs and primary UI terminology to this conversation-first model.
- Phase 6E added optional Codex app-server steering/interrupt for planning-agent and coder-agent turns, with `codex exec` fallback.
- Phase 6F added Result Review + Apply Handoff: after coder / validation / audit evidence exists, the main conversation and right inspector summarize changed files, validation, audit notes, apply readiness, and the final local action.
- Phase 6G adds AgentTaskRepository projection: foreground role handoffs and background maintenance candidates are visible as task/result evidence, while the primary user surface remains the demand conversation.
