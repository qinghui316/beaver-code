<!-- ECL-HARNESS:BEGIN -->
# agent-harness-orchestrator Claude Route

<!-- ECL-HARNESS-PROJECT-ID: agent-harness-orchestrator-a6ad344cbe4e -->

When available, use the local `agent-harness-orchestrator-a6ad344cbe4e-harness` Skill for structured project work, Change handling, worktree
coordination, Integration, and Harness evolution. Maintainer work continues to follow its Change and I2 gates. Keep detailed rules in the shared Skill rather
than duplicating them here.

For a maintainer worktree whose primary checkout already contains the shared Skill, run one available host connector if discovery links are missing:

```text
PowerShell: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/harness-skill-link.ps1
Node.js:    node scripts/harness-skill-link.mjs
Python:     python3 scripts/harness-skill-link.py (or python on Windows)
```

Then reload the project Harness; single-Lane Small Changes use targeted verification, while Structured and multi-Lane repository work publish scope and run Registry preflight. Before removing this secondary worktree, rerun the same connector with `-Detach` for PowerShell or `--detach` for Node.js/Python.
<!-- ECL-HARNESS:END -->

## Public Contributions

Public clones do not contain the maintainer's local Harness. Follow `AGENTS.md` and
`docs/DEVELOPMENT.md` for contributor guidance, builds and checks. A public contribution
does not require the private working records. Preserve unrelated changes and run
`npm run typecheck`, `npm run lint` and relevant tests before submitting a pull request.
