# Starting a Continuum task

Each new chat must establish its own checkout and runtime context. A Cursor Project
can organize chats, but is not evidence that a branch, database or private file is current.

1. Read `AGENTS.md`, then inspect `git status --short`, `git remote -v`,
   `git branch --show-current`, `git rev-parse HEAD` and `git worktree list`.
2. Fetch main explicitly: `git fetch origin refs/heads/main:refs/remotes/origin/main`.
   Some local clones fetch only one task branch. Preserve dirty files; do not reset
   or switch someone else's active checkout. Create one focused task branch from
   the fetched main when authorized to implement.
3. Read `docs/ARCHITECTURE.md`, `docs/M1-SAFETY-CONTRACTS.md`,
   `docs/RECOVERY-CONTRACT-v0.2.md`, and relevant M1 contract extensions. Consult
   `docs/reconciliation/CANONICAL-GAP-REGISTER.md`,
   `docs/reconciliation/CANONICAL-TRACEABILITY.md`,
   `docs/interface/PRODUCT-CONTRACT.md` and `docs/interface/FOCUS-DESK-DESIGN.md`
   for the task's requirements and existing coverage.
4. Read `docs/plan/START-HERE.md`, `docs/plan/CURRENT-PLAN.md` and
   `docs/plan/OWNER-DECISIONS.md`, then the approved task proposal. Check actual
   current-main work against the snapshot. Find the private environment guide with
   `git config --get continuum.environmentGuide` or owner-provided Project context.
   Linked worktrees share the local locator; fresh clones/cloud machines do not.
   Missing private material is a missing input, not permission to reconstruct
   decisions from older donors or a previous chat.
5. Read `README.md` and `docs/TESTING.md`. Identify the Linux distribution/user,
   Node 24 backend, separate Node 22 frontend, PostgreSQL 17 binaries, Chromium,
   restricted fixture helper and owned fixture cluster. Obtain private local paths
   from the owner's environment guide. Cloud runners use their workflow setup.
6. Run focused checks while editing, then required canonical verification at the
   coherent checkpoint. Report exact source identity, runtime, results, artifacts,
   local adaptations and unverified surfaces. Hosted success on the final PR head
   is separate from a local run on earlier or modified bytes.
7. Open one small PR. Check current-head comments and CI; resolve only verified
   findings. Owner merge approval is separate. After merge, verify main's checks,
   update the plan and propose the next dependency-ready product task. Future
   deployment work does not automatically displace the phased product plan.

Use the existing workflow rule for review and CI efficiency. Save useful handover
details in reviewed documentation rather than relying on chat history. Public
instructions must not contain local account paths, passwords or private reference
archives. An environment guide is a snapshot: recheck database ownership and running
clients before every destructive fixture operation.
