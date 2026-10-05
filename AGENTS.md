# Beaver Code Contributor Route

Agent Harness Orchestrator (AHO) is a local-first Agent Development OS. The project Harness is the
self-contained source of AI working knowledge and owns current Change, Lane, Integration, and
Evolution state. Repository documents under `docs/` are maintained for people and may be used as
temporary analysis leads, but the project Harness does not depend on them for project semantics.

<!-- ECL-HARNESS:BEGIN -->
# agent-harness-orchestrator Agent Route

<!-- ECL-HARNESS-PROJECT-ID: agent-harness-orchestrator-a6ad344cbe4e -->

When the local `agent-harness-orchestrator-a6ad344cbe4e-harness` Harness Skill is available, load it before structured
development, worktree coordination, Integration, or Harness evolution. Maintainer work continues to follow its Change and I2 gates.

For a maintainer worktree whose primary checkout already contains the shared Skill, run one available host connector if discovery links are missing:

```text
PowerShell: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/harness-skill-link.ps1
Node.js:    node scripts/harness-skill-link.mjs
Python:     python3 scripts/harness-skill-link.py (or python on Windows)
```

Then reload the project Harness; single-Lane Small Changes use targeted verification, while Structured and multi-Lane repository work publish scope and run Registry preflight. Before removing this secondary worktree, rerun the same connector with `-Detach` for PowerShell or `--detach` for Node.js/Python.

- Preserve unrelated changes and follow existing project verification.
- Current Change artifacts and history live in the shared project Harness.
- Shared Lane and contract facts come from the project Harness Registry.
- Business Integration requires explicit user I2 confirmation.

Do not copy the Harness manual into this file.
<!-- ECL-HARNESS:END -->

## Public Contributions

Public clones do not include the maintainer's local shared Harness or working records.
Use `docs/DEVELOPMENT.md` for prerequisites, build commands and validation. You can develop
and submit a pull request without access to the maintainer's Harness. Repository integration
and releases remain maintainer-reviewed operations.

Before submitting a contribution, run `npm run typecheck`, `npm run lint` and the tests
relevant to your change. Keep credentials, local conversation data, logs and acceptance
reports outside the tracked source tree; `npm run lint:public-repository` checks tracked paths.

Human-facing product documents:

- `docs/PRODUCT.md`
- `docs/ARCHITECTURE.md`
- `docs/BOUNDARIES.md`
- `docs/RUNTIME.md`
- `docs/WORKBENCH.md`
- `docs/AGENT-MODEL.md`
- `docs/CURRENT-DEVELOPMENT-PLAN.md`
- `docs/DEVELOPMENT.md`

Preserve unrelated user changes.
