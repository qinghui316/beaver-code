# Development Setup

## 1. Product Development Scope

This repository contains the TypeScript CLI, workflow and evidence owners, provider adapters,
Workbench server and frontend, product Harness templates, and local development tooling.

Current Change state, Lane ownership, and resumable work live in the project Harness Registry and active Change summary. This document lists stable product-development commands rather than task history.

## 2. Prerequisites

- Git.
- Windows PowerShell 5.1 or PowerShell 7.
- Node.js 20+.
- npm.
- Codex CLI for `aho run codex` manual acceptance.
- Network access only when you choose to clone optional local reference projects.

## 3. Reference Sources

Reference repositories are optional local-only development material. They are not Git submodules and are not required for a normal checkout. Load the project Harness reference index and the relevant source map before inspecting a checkout; clone into `reference-projects/` only when a task needs source-level evidence.

Suggested local source paths:

- `reference-projects/agent-orchestrator/`
- `reference-projects/oh-my-codex/`
- `reference-projects/ecl-harness-engineer/`

## 4. Product Commands

```powershell
npm install
npm run typecheck
npm run lint
npm run test
npm run build
node dist/index.js --help
```

`npm run test` is the full verification gate and includes heavy Workbench and CLI integration-style coverage. For faster local iteration, use:

```powershell
npm run test:fast
npm run test:workbench
npm run test:workbench:release
npm run test:workbench:slow
npm run test:integration
```

`npm run test:fast` excludes explicit Workbench capability suites, slow
Workbench suites, and CLI integration coverage. Use `npm run test:workbench`
for the daily Workbench regression gate; it runs the explicit Workbench unit
capability suites in one Vitest invocation. Use `npm run test:workbench:release`
for the full Workbench contract, including slow/deep Workbench suites. Use
`npm run test:workbench:slow` when iterating only on slow Workbench flows.


The CLI command name is `aho` when installed from the package bin.

## 4A. Beaver Code desktop development

The Windows desktop foundation targets a current-user x64 NSIS installer. It is
an unsigned internal acceptance build, not a public 1.0 release.

```powershell
npm run dev:desktop
npm run build:desktop
npm run test:desktop:native
npm run package:desktop:win
npm run verify:desktop:package
npm run lint:desktop-boundaries
```

`build:desktop` consumes the same compiled Workbench assets as the browser
product. `test:desktop:native` launches Electron and proves that the packaged
ABI can load `better-sqlite3` and start a real `node-pty` session.
`package:desktop:win` creates `Beaver-Code-Setup-<version>-win-x64.exe` under
`release/desktop/`; `verify:desktop:package` checks the installer and unpacked
Windows x64 native resources. The current locked dependencies ship official
Windows x64 prebuilt binaries, which are accepted only after both Electron
runtime smoke and package-layout verification pass. Runtime network downloads
of native modules are not allowed.

Desktop application data remains under `~/.agent-harness`. Window state and
bounded host logs use `~/.agent-harness/desktop`; uninstall must preserve this
directory by default.

## 5. Structured Change Commands

Use a temporary `AHO_HOME` for manual acceptance if you do not want to touch your real registry:

```powershell
$env:AHO_HOME = "$PWD\.tmp\aho-home"
```

Core flow:

```powershell
node dist/index.js project add ..\aho-test-project --name aho-test
node dist/index.js harness init aho-test
node dist/index.js change new aho-test --title "Add sample workflow" --body "Raw user request"
node dist/index.js change status aho-test --json
node dist/index.js change close aho-test
```

The Workbench path is the normal interactive entrypoint. Registering or
creating a project from the Workbench prepares the default `external-local`
marker and runtime directories automatically; the first conversation can then
start immediately. It does not generate project Harness documents before the
Main Agent turn. The explicit CLI `harness init` command remains for the
legacy/compatibility CLI flow and for choosing `repo-local` deliberately.

`change close` blocks while `reviews/review.md` is `Status: pending`. Change it to `Status: approved` or `Status: approved-with-notes` to close after reviewing the artifacts.

## 6. Memory Diagnostics

Memory diagnostics show how AHO resolves a project's durable memory layout. This is diagnostic only; `harness audit` remains the readiness gate.

```powershell
node dist/index.js memory status aho-test
node dist/index.js memory status aho-test --json
```

`external-local` is the default for new Workbench projects. `repo-local`
remains an explicit compatibility mode for CLI-managed repositories. `remote`
remains planned/unsupported.

External-local initialization keeps durable memory outside the target repository:

```powershell
node dist/index.js project add ..\aho-test-project --name aho-test
node dist/index.js harness init aho-test --memory external-local
node dist/index.js memory status aho-test --json
```

The target repository receives only the AHO marker and runtime ignore file from
this initialization path. Durable project documents, Harness files, scripts,
changes, and runs live under AHO home; the Main Agent creates project-specific
documents during the first conversation when the project actually needs them.

## 7. Local Command Run Commands

Runs require a registered, managed project with exactly one active change. Commands are executed directly in the target project root with executable-plus-arguments semantics; shell pipes, redirects, and interactive sessions are not supported.

```powershell
node dist/index.js run start aho-test -- npm run test
node dist/index.js run list aho-test --json
node dist/index.js run show aho-test <run-id> --json
```

Run artifacts are written under the target project:

```text
.agent-harness/runs/{run-id}/
  run.json
  context.md
  events.jsonl
  stdout.log
  stderr.log
```

For external-local projects, run artifacts are written under the resolved memory root and `run.json` uses `artifacts.base: "memory-root"`.

## 8. Workbench Snapshot Commands

Workbench commands build GUI-ready read models from canonical artifacts. They do not write files, call Codex, or advance workflow state.

```powershell
node dist/index.js workbench snapshot aho-test --json
node dist/index.js workbench snapshot aho-test --topic <change-id> --json
node dist/index.js workbench stream aho-test <run-id> --json
node dist/index.js workbench approvals aho-test --json
node dist/index.js workbench approvals aho-test --topic <change-id> --json
node dist/index.js workbench topics aho-test --json
node dist/index.js workbench topic aho-test <change-id> --json
node dist/index.js workbench roles aho-test --json
node dist/index.js workbench serve --host 127.0.0.1 --port 4317 --open
node dist/index.js workbench serve aho-test --host 127.0.0.1 --port 4317 --open
```

`snapshot` returns:

- project and memory status;
- demand conversation list backed by internal Topic/Change records;
- selected demand conversation detail;
- semantic thread items;
- agent loop run summaries;
- approval inbox items;
- structured approval actions;
- bundled role summaries;
- `harnessGaps` for workspace/session/subagent structures that are still missing or partial.

`stream` is replay-only. It reads existing run artifacts and returns metadata, parsed events, artifact pointers, bounded previews, and diagnostics for missing artifacts. It does not start a run or provide live WebSocket/SSE streaming.

`approvals` is a derived view. It returns project-level approval items by default, with optional Topic filtering for display. Mutating actions include structured command metadata and require explicit confirmation.

The snapshot is a derived view for future GUI work. It is not a new source of truth.

`serve` starts the local browser Workbench. Without a project argument, it
opens the three-pane Workbench shell; project onboarding lives in the left
sidebar. A user can add an existing local project with the native folder
picker or create a new local project folder from a selected parent directory.
Registration prepares the default external runtime automatically, and the
first demand goes directly to the Main Agent; no separate Harness-document
generation step is required. With a project argument, it direct-opens that
project. The server serves the Vite-built static UI from `dist/web` and
exposes local JSON APIs for project onboarding, native folder selection,
snapshot, internal topics/change records, replay stream packets, approvals,
and allowlisted approval actions. Mutating actions require `confirm: true`;
the server does not accept arbitrary shell commands.

The Phase 5C GUI starts as replay-only. The Agent Loop surface is designed for future live streaming, but run detail data still comes from existing artifacts through `workbench stream`.

Workbench APIs still expose historical Topic paths for compatibility. The
user-facing model is a conversation under a project; ordinary conversation ids
are independent from Harness Change ids, and workflow evidence is addressed by
explicit Change scope when a real Harness gate/action is involved.

```text
POST /api/projects/:projectId/workbench/topics
GET  /api/projects/:projectId/workbench/topics/:changeId/messages
POST /api/projects/:projectId/workbench/topics/:changeId/messages
GET  /api/projects/:projectId/workbench/topics/:changeId/messages/stream
POST /api/projects/:projectId/workbench/actions
GET  /api/projects/:projectId/workbench/actions/:actionRunId
GET  /api/projects/:projectId/workbench/actions/:actionRunId/events
```

Ordinary chat messages use the Workbench canonical timeline in the resolved SQLite store. Schema
16, 17, 18, and 19 databases upgrade to Schema 20 through explicit forward migrations after a quiescence
check and verified sidecar backup. Populated older schemas, future schemas, damaged databases, and
failed recovery markers are preserved and isolated instead of being rebuilt or cleared. Never
delete a project's Workbench database, WAL, migration snapshot, or recovery marker to make startup
pass. Diagnose against a copy and preserve the original evidence. Provider session ids are
continuity metadata and do not override Shared Conversation context or Harness facts. Accepted
`spec.md`, `plan.md`, `tasks.md`, review, run, validation, audit, apply, and close artifacts remain
the workflow sources of truth.

Schema 19 preserves historical Provider Attempts as `legacy-v0` when their
original execution semantics were not recorded. New Attempts must receive their
execution identity from the shared Registry. Active legacy or older-epoch
Conversation Queue items are content-preserving but require exact execution
confirmation before dispatch; do not repair them by editing SQLite rows or
advancing epochs in individual controllers.

Focused migration verification:

```powershell
npx vitest run tests/unit/workbench-database-upgrade.test.ts tests/unit/workbench-persistence-repositories.test.ts --pool=forks --poolOptions.forks.singleFork
npx vitest run tests/unit/workbench-server.test.ts --pool=forks --poolOptions.forks.singleFork
```

Historical-data acceptance must use copied databases under a temporary `AHO_HOME`. A test may
inspect the live Registry to locate candidates, but it must not open a live user database in
read-write mode or place migration artifacts beside it.

Current Plan, clarification, and provider questions are exposed through
`GET` snapshot interaction projection and settled through the single opaque
`POST /api/projects/:projectId/workbench/conversations/:conversationId/interactions/:interactionId/settle`
route. Clients must not submit provider session, thread, turn, item, or request
routing fields.

`POST /api/projects/:projectId/workbench/actions` only accepts allowlisted action types such as `chat.ask`, `change.spec.propose`, `change.spec.accept`, `change.plan.propose`, `change.plan.accept`, `code.run`, `validate.run`, `audit.run`, and `spec-test.drift`. Mutating actions still require `confirm: true`; the server does not accept arbitrary shell commands.

## 9. Skill and Provider Bridge Commands

Bundled AHO system Skills are exposed from the bundled Skill root through the
Codex native Skill protocol. Project and custom Skills remain in the resolved
memory root; Codex bridge copies for those Skills are rebuildable runtime
projections.

Production Workbench and Workflow Runtime entrypoints select the applicable
role and provide the current task/workspace facts. They do not paste Skill
documents into the natural-language task. Codex discovers bundled AHO Skills
through the native protocol; non-system project Skills use the synced
`aho-managed` bridge and are loaded progressively by Codex itself.

```powershell
node dist/index.js agent list aho-test --json
node dist/index.js agent show aho-test coder --json
node dist/index.js agent sync aho-test --json

node dist/index.js skill import aho-test --path C:\path\to\skill
node dist/index.js skill list aho-test --json
node dist/index.js skill enable aho-test pricing-skill
node dist/index.js skill disable aho-test pricing-skill --conversation-id <conversation-id>

node dist/index.js provider bridge status codex --json
node dist/index.js provider bridge status codex aho-test --json
node dist/index.js provider bridge install codex --json
node dist/index.js provider bridge sync codex aho-test --json
```

`skill import` copies only `SKILL.md`, `references/`, and `examples/`. It does not import `scripts/`.

`agent sync` copies bundled role contracts into the resolved memory root and writes `agent-catalog.json` when missing. Memory role files can be inspected and, in later phases, become the override point for project-specific role contracts.

Product commands such as `change spec propose`, `change plan propose`, `code
run`, and `audit run` remain the executable workflow entrypoints. They reuse
the role catalog and record role provenance in run metadata; there is no
separate `agent run` production path. Starting with Phase 7J, `code run` is no
longer an unconditional write-mode shortcut: it must pass the same typed
DecompositionReadinessManifest gate as Workbench `code.run`, while `validate
run` and `audit run` remain post-code evidence commands.

`provider bridge install codex` writes only the AHO namespace:

```text
<CODEX_HOME or ~/.codex>/plugins/aho-managed/
  plugin.json
  skills/
  agents/
  commands/
```

`provider bridge sync codex <project>` materializes enabled project/topic skills as project-qualified Codex skills such as `{project-id}__{skill-id}` and role contracts under `agents/`. It does not overwrite user-managed Codex skills, oh-my-codex skills, or global Codex configuration. Runs record enabled skill ids, source hashes, materialized hashes when synced, role id, role source hash, catalog hash, bridge version, and prompt stack.

## 10. Worktree Commands

Worktrees require a registered, managed project. `worktree create` requires exactly one active change. `list`, `show`, and `remove` do not require an active change so old worktrees can be cleaned up after archive.

```powershell
node dist/index.js worktree create aho-test --json
node dist/index.js worktree list aho-test --json
node dist/index.js worktree show aho-test <worktree-id> --json
node dist/index.js worktree remove aho-test <worktree-id>
```

Real Git checkouts are stored under AHO home. Metadata is stored under the active memory root. Dirty worktrees cannot be removed unless `--force` is provided.

Local command runs can execute inside a new AHO-managed worktree:

```powershell
node dist/index.js run start aho-test --worktree -- npm test
```

`run start --worktree` records `executionMode: "worktree"` and keeps the checkout after completion for inspection.

## 11. Validation Commands

Validation is mechanical evidence for the current active change. It does not replace review or human confirmation.

```powershell
node dist/index.js validate run aho-test
node dist/index.js validate run aho-test --worktree
node dist/index.js validate run aho-test --worktree <worktree-id>
node dist/index.js validate status aho-test --json
node dist/index.js validate list aho-test --json
node dist/index.js validate show aho-test <validation-id> --json
```

Profile resolution:

1. `harness/config/environment.json`
2. package fallback for `typecheck`, `lint`, `test`, and `build`

Validation artifacts are written under the active memory root:

```text
runs/{run-id}/validation.json
runs/{run-id}/commands/*.stdout.log
runs/{run-id}/commands/*.stderr.log
```

The close gate blocks the latest failed validation for the current change. Missing validation is warning-only in Phase 3B.

## 11. Spec-Test Mapping Commands

Spec-test mappings connect Acceptance Criteria to test or validation evidence. They are explicit linked evidence, not proof that the AC is fully covered.

```powershell
node dist/index.js spec-test link aho-test --ac AC-001 --file test\pricing.test.js --test-name "normal customers pay subtotal" --command test
node dist/index.js spec-test link aho-test --ac AC-002 --command build
node dist/index.js spec-test status aho-test --json
node dist/index.js spec-test status aho-test --worktree <worktree-id> --json
node dist/index.js spec-test check aho-test --json
node dist/index.js spec-test drift aho-test --json
node dist/index.js spec-test drift aho-test --worktree <worktree-id> --json
node dist/index.js spec-test check aho-test --strict --json
node dist/index.js spec-test unlink aho-test --ac AC-001 --command test
```

`spec-tests.json` lives in the active change directory. File paths are repo-relative logical paths. `testName` is recorded for human review only; AHO does not parse test runner output in Phase 4A.

Missing linked evidence is warning-only. A linked file that does not exist is blocking because it is bad evidence.

`spec-test drift` is a deterministic readiness check. It reports whether each AC is `ok`, `missing`, `invalid`, `stale`, `failed`, or `unknown` against the selected latest validation and root. `stale` is risk-based and may come from mtime comparisons; it is not proof that the implementation is wrong. `spec-test check --strict` exits non-zero for invalid, stale, or failed accepted evidence, but still treats missing evidence as warning-only.

Spec-test proposal runs ask Codex to inspect existing tests and propose candidate evidence. Codex output is proposal-only; it does not edit `spec-tests.json`.

```powershell
node dist/index.js spec-test propose aho-test --json
node dist/index.js spec-test propose aho-test --worktree <worktree-id> --prompt "Prefer existing regression tests." --json
node dist/index.js spec-test proposal list aho-test --json
node dist/index.js spec-test proposal show aho-test <proposal-id> --json
node dist/index.js spec-test proposal accept aho-test <proposal-id> --ac AC-001 --ref ev-001
node dist/index.js spec-test proposal accept aho-test <proposal-id> --all-existing
```

`proposal accept` is the human confirmation command. In Phase 4B it only accepts `source-root` + `existingEvidence` candidates. Worktree-only evidence, suggested new tests, open questions, and unknown evidence are skipped or rejected. AHO still uses deterministic `spec-test link` logic for the actual write to `spec-tests.json`.

## 12. Spec-Test Generation Commands

Spec-test generation asks Codex to create a passing test evidence proposal in a new AHO-owned worktree. It is test-only, proposal-only, and does not edit `spec-tests.json`.

```powershell
node dist/index.js spec-test generate aho-test --missing --prompt "Add minimal tests for missing AC evidence." --json
node dist/index.js spec-test generate aho-test --ac AC-001 --ac AC-002 --json
```

Generation behavior:

- `--missing` selects only ACs with no linked evidence.
- `--ac` and `--missing` are mutually exclusive.
- Codex runs with workspace-write in an AHO-owned worktree.
- The source repo is read/context only until explicit `worktree apply`.
- Diffs outside test-like paths cause the generator run to fail and keep artifacts for diagnosis.
- Generated tests must pass validation and audit before apply.
- After apply, use `spec-test propose` and `spec-test proposal accept` to write accepted evidence mappings.

Typical flow:

```powershell
node dist/index.js spec-test status aho-test --json
node dist/index.js spec-test generate aho-test --missing --json
node dist/index.js validate run aho-test --worktree <generated-worktree-id> --json
node dist/index.js audit run aho-test --worktree <generated-worktree-id> --json
node dist/index.js audit accept aho-test <audit-id> --json
node dist/index.js worktree preview aho-test <generated-worktree-id> --json
node dist/index.js worktree apply aho-test <generated-worktree-id> --commit --message "add spec-test evidence"
node dist/index.js spec-test propose aho-test --json
node dist/index.js spec-test proposal accept aho-test <proposal-id> --all-existing --json
node dist/index.js spec-test status aho-test --json
```

Generator artifacts are written under the active memory root:

```text
runs/{run-id}/run.json
runs/{run-id}/context.md
runs/{run-id}/prompt.md
runs/{run-id}/codex-events.jsonl
runs/{run-id}/last-message.md
runs/{run-id}/diff.patch
runs/{run-id}/diff-stat.txt
runs/{run-id}/implementation.md
```

Phase 4C does not support accepted red tests, CI drift gates, or automatic proof of AC coverage. Phase 4D adds local drift diagnostics only; CI enforcement remains future work.

## 13. Spec And Plan Proposal Commands

Spec and Planner agents are read-only proposal agents. They do not write canonical ECL files until the user runs an explicit accept command.

```powershell
node dist/index.js change spec propose aho-test --prompt "Clarify this raw request into testable ACs." --json
node dist/index.js change spec proposal list aho-test --json
node dist/index.js change spec proposal show aho-test <proposal-id> --json
node dist/index.js change spec accept aho-test <proposal-id> --json

node dist/index.js change plan propose aho-test --json
node dist/index.js change plan proposal list aho-test --json
node dist/index.js change plan proposal show aho-test <proposal-id> --json
node dist/index.js change plan accept aho-test <proposal-id> --json
```

`spec propose` reads the active Change summary/raw request, current `spec.md` draft, and bounded project docs. It produces `spec-proposal.json`, `spec-proposal.md`, `prompt.md`, `last-message.md`, Codex JSONL, and run logs. The proposal must contain testable `AC-xxx` IDs before it can be accepted.

`plan propose` requires accepted/manual `spec.md` with at least one parseable AC. It produces `plan-proposal.json` and `plan-proposal.md`; accepted tasks must use `T-xxx` IDs and `Covers: AC-xxx` mappings. `plan accept` writes `plan.md` and `tasks.md`, then rebuilds `ac-map.json`.

Both accept commands are stale-safe: if the target file changed after proposal generation, accept aborts and the user must re-run the proposal. Accepting a proposal does not update review status, run code, validate, audit, apply, close, or accept spec-test evidence.

## 14. Code Commands

Code runs use Codex workspace-write mode in a new AHO-owned worktree. They produce implementation proposals and diff artifacts, but do not apply, merge, validate, audit, or close the change. Phase 7J requires a latest confirmed DecompositionPlan plus a valid DecompositionReadinessManifest whose `nextAllowedAction` is `code.run`; sequential taskgraph readiness must use TaskQueueProposal instead of direct `code run`.

```powershell
node dist/index.js code run aho-test --prompt "Implement only the requested README Usage section."
node dist/index.js code run aho-test --task T-001 --prompt-file .\coder-extra.md --json
node dist/index.js code status aho-test --json
node dist/index.js code list aho-test --json
node dist/index.js code show aho-test <run-id> --json
```

Coder artifacts are written under the active memory root:

```text
runs/{run-id}/run.json
runs/{run-id}/context.md
runs/{run-id}/prompt.md
runs/{run-id}/codex-events.jsonl
runs/{run-id}/last-message.md
runs/{run-id}/diff.patch
runs/{run-id}/diff-stat.txt
runs/{run-id}/implementation.md
```

After a successful Coder proposal, use the same worktree id for authoritative validation and audit:

```powershell
node dist/index.js validate run aho-test --worktree <coder-worktree-id>
node dist/index.js audit run aho-test --worktree <coder-worktree-id>
```

Dirty active Coder worktrees block `change close`. Use validation, audit, audit accept, and worktree apply before closing an implemented change.

## 15. Apply / Discard Commands

Apply is the explicit human confirmation gate that adopts a validated and audited worktree diff into the source repo. It is not merge, push, PR, or close.

```powershell
node dist/index.js worktree preview aho-test <worktree-id> --json
node dist/index.js worktree apply aho-test <worktree-id>
node dist/index.js worktree apply aho-test <worktree-id> --commit --message "apply accepted change"
node dist/index.js worktree discard aho-test <worktree-id>
```

Apply requires:

- source repo is clean
- source `HEAD` still matches the worktree base commit
- current worktree diff is non-empty
- latest passed validation matches the same `worktreeDiffHash`
- latest approved audit matches the same `worktreeDiffHash`
- `reviews/review.md` references the same accepted `Audit ID`

`worktree apply` without `--commit` leaves source repo changes uncommitted. `change close` blocks until the source repo is clean. `worktree discard` only removes an unapplied proposal checkout; it does not revert already applied source changes.

## 16. Audit Commands

Audit is semantic review evidence for the current active change. It does not replace human confirmation.

```powershell
node dist/index.js audit run aho-test
node dist/index.js audit run aho-test --worktree <worktree-id>
node dist/index.js audit status aho-test --json
node dist/index.js audit list aho-test --json
node dist/index.js audit show aho-test <audit-id> --json
node dist/index.js audit accept aho-test <audit-id>
```

Audit artifacts are written under the active memory root:

```text
runs/{run-id}/audit.json
runs/{run-id}/audit.md
runs/{run-id}/diff.patch
runs/{run-id}/diff-stat.txt
runs/{run-id}/last-message.md
```

`audit run` is read-only and proposal-only. `audit accept` is the explicit human confirmation command that writes an approved audit into `reviews/review.md`.

The close gate blocks only the latest `blocked` audit for the current change. Missing audit and failed/unparseable audit are warning-only in Phase 3C.

## 17. Codex Read-Only Proposal Runs

Codex runs require a registered, managed project with exactly one active change. AHO reuses the user's local Codex CLI login and configuration. It does not run `codex login`, read tokens, or modify `~/.codex`.

```powershell
node dist/index.js run codex aho-test --prompt "Read the run context and propose an implementation plan. Do not edit files."
node dist/index.js run codex aho-test --prompt-file .\prompt.md --json
```

`run codex` is proposal-only. It uses Codex read-only sandboxing when supported and records failures as artifacts instead of falling back to writable or full-auto modes.

Additional artifacts:

```text
.agent-harness/runs/{run-id}/
  prompt.md
  codex-events.jsonl
  last-message.md
```

## 18. Beaver Code Internal Builds

```powershell
npm run build:desktop
npm run test:desktop:native
npm run package:desktop:win
npm run verify:desktop:package
```

`build:desktop` creates `dist/desktop/build-info.json` from the package version, full Git commit,
UTC build time, internal channel, and current dirty flag. The file is generated output and is not
committed. `package:desktop:win` refuses a dirty worktree before compiling and again before invoking
Electron Builder. Package verification checks the Windows x64 installer, embedded build identity,
native module layout, architecture exclusions, and source-map exclusions.

An internal candidate installer may be used for controlled acceptance. The locally retained demo
installation must be rebuilt from the exact canonical `master` commit after Change close and an
explicit I2 Integration. Desktop upgrades preserve `~/.agent-harness`.

## 19. Windows Stable Updates

The update channel uses Electron Builder 26 and electron-updater 6.8.9 with NSIS. Ordinary
packaging explicitly uses `--publish never`. Output is under
`release/desktop/<internal|test|stable>/`; generated builder configuration is outside
the packaged source tree.

- With no build environment override, `build:desktop` and `package:desktop:win` produce
  internal builds with network updating disabled.
- `BEAVER_BUILD_CHANNEL=test` selects a separate application id, executable, updater
  cache name and user data. It requires `BEAVER_TEST_UPDATE_URL` (isolated HTTPS),
  `BEAVER_PUBLISHER_SUBJECT` (exact certificate subject), and signing credentials.
  Optional `BEAVER_TEST_VERSION` changes only the isolated fixture package version.
- `BEAVER_BUILD_CHANNEL=stable` requires a committed Ed25519 public trust root and an encrypted
  PKCS#8 signing key supplied only through the protected release Environment. Its fixed source is
  `qinghui316/beaver-code` GitHub Releases and cannot be changed from the UI or startup arguments.
- Stable packaging generates `beaver-update-win-x64.json`, its detached signature, a release receipt,
  and checksums. `npm run verify:update-release` verifies those files independently.
- Authenticode is optional until the Windows certificate is available. When enabled, both the exact
  publisher subject and Electron Builder signing credential must be present; partial configuration
  fails closed. Never commit a certificate, password, or private key.
- Stable packages require a clean checkout. The signed manifest binds the full Commit, installer,
  blockmap, names, sizes, and SHA-512 values; package validation also checks native layout.
- Packaging executes the native smoke against modules inside the unpacked ASAR
  layout, using the matching Electron executable.

Test builds use `~/.beaver-code-update-test/data` and a separate Chromium profile;
they must never register the developer's real projects. Use disposable Windows
isolation for certificate trust and installation-fault tests. Do not install the
test root certificate in the ordinary host's trust store.

The release workflow is tag-triggered. It verifies the exact version tag and canonical Commit,
checks the code, then uses the protected `windows-signing` Environment to build, sign, create, and
re-download a draft. A separate `windows-release` Environment grants the human-reviewed publication
step only after the exact draft exists; that step re-verifies every asset before publication.
Configure required reviewers, Ed25519 secrets, key identity, and the release switch before enabling
it. A named Environment in YAML alone does not establish reviewer protection.

An installed 0.1.2 build has no network updater. Install verified 0.1.4 manually once; use a later
patch to prove the first real update. Download completion shows a non-blocking choice and never
restarts the application until the user chooses it. An interrupted NSIS installation is repaired
with a trusted same-version or corrected installer;
never restore an old database over newer user records or delete application data.

The operational key ceremony, GitHub setup, publication, withdrawal, and forward-repair procedure
is maintained in `docs/DESKTOP-RELEASE.md`.
