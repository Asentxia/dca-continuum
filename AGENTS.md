# Continuum agent starting point

This repository implements Asentxia Continuum. Read `docs/AGENT-START.md` before
substantial work and follow the existing `.cursor/rules/20-continuum-workflow.mdc`.
Read `docs/plan/START-HERE.md`, `docs/plan/CURRENT-PLAN.md` and
`docs/plan/OWNER-DECISIONS.md` to select work. These are the maintained task and
decision records; private older revisions are history, not the current queue.

## Preserve the contracts

- PostgreSQL owns domain truth; the Effect Controller enforces consequential actions.
- VERA, human, workload, logical Computer, and physical placement are distinct.
- Preserve immutable operation bindings, exact approvals, tenant isolation, final-send
  checks, placement fencing, and observation-only UNKNOWN reconciliation. Context
  and cognition never create authority. Never retry an uncertain external effect.
- Current implementation describes what exists. Frozen safety and recovery contracts
  constrain changes. Old archives and donor repositories are reference, not approval.
- Production stays BLOCKED, scheduler HELD, and canary NO-GO unless independently
  qualified and explicitly authorized. Local tests cannot advance these gates.

## Work in small pull requests

Inspect the actual root, remote, branch, commit, worktrees and dirty files first.
Preserve existing work. Fetch current main explicitly; work on a focused branch or
isolated worktree. Do not assume an earlier chat updated the local checkout.

Read the task's approved proposal and relevant contracts. Record unresolved decisions;
do not infer approvals from recommendations or handoff documents. For defects,
reproduce first, preserve a regression, fix minimally and run affected checks plus
the relevant canonical suite. Record exact tested source and distinguish adaptations,
unrun checks and prior-commit evidence from final-head results.

Commit and non-force push only authorized scope. Validate review comments against
current code before fixing or resolving them. Avoid overlapping bot reviews and
duplicate successful CI runs. Do not merge, deploy, provision paid resources, change
visibility/licensing, or start shadow/canary without separate owner authorization.
Never commit credentials, private archives or unreviewed untracked handoff files.

## Local safety

Read `docs/TESTING.md`. Use Linux with the documented runtimes, not the first Node or
WSL distribution found on PATH. Check the running database's actual data directory
before resets. Do not reuse another task's cluster, edit test cleanup to bypass the
fixture helper, or change helper configuration without authorization. Do not kill
unrelated processes or shut down WSL. Keep machine-specific paths outside Git.
Find the private guide with `git config --get continuum.environmentGuide` or
owner-provided Project context. Linked worktrees share that local Git setting;
new clones/cloud agents do not. Read its value as a path, never execute it blindly.
Carry the locator into task handovers and report missing access before local testing.
