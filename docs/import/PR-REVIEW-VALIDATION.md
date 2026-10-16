# PR 2 comment validation and narrow corrections

Review baseline: `37a8ea0e8e9aad708c9a5c2d3815dff5bbef8129`.
This record distinguishes reproduced defects, scanner classifications and coverage
limits. It is not owner acceptance, a whole-product audit or release approval.

## Cursor fixture-helper race — confirmed and corrected, CI retest required

Comment: https://github.com/Asentxia/dca-continuum/pull/2#discussion_r4294579364

The old helper checked a path and then called `os.chown(path)` with symlink
following. A deterministic unprivileged reproduction replaced the last component
at the ownership-operation boundary and observed resolution to an out-of-fixture
inode in a temporary directory. Ownership was mocked: no actual root operation,
host object or outside account was changed. The mechanism is confirmed; the
specific `/etc/cron.d` impact described by the bot was not executed.

The correction walks absolute, normalized physical directory components using
`O_DIRECTORY | O_NOFOLLOW`, opens the direct child relative to the pinned parent
file descriptor and calls `os.fchown` on that descriptor. Swapping the child or an
ancestor after opening cannot redirect that ownership operation. Symlinked
fixture roots/ancestors fail closed; configurations must use physical paths.
The allowed UID/GID ranges and operation allowlist are unchanged.

Ten unprivileged regression tests cover ordinary directories, final/ancestor
symlinks, deterministic swaps before/after open, regular files, invalid paths and
owners, and descriptor cleanup. They run in the Workflow security check. This is
not a review or certification of the helper's separate process/namespace paths.

## CodeQL annotations — preserve the gate and verify the new scan

- https://github.com/Asentxia/dca-continuum/pull/2#discussion_r4294523049:
  the reported password sources are four spreads of `noAuthority`, a record of
  three literal false effect-denial flags. These are not observed passwords.
  Rename the misleading shared identifier to `deniedEffectFlags`, documenting
  its meaning. Reversing that rename yields identical emitted JavaScript with
  comments removed. Canonical payloads, SHA-256 and evidence-chain behavior are
  unchanged. No query suppression, severity waiver or password-hash substitution
  is made. A fresh CodeQL result is required before calling this alert cleared.
- https://github.com/Asentxia/dca-continuum/pull/2#discussion_r4294523068
  and https://github.com/Asentxia/dca-continuum/pull/2#discussion_r4294523090:
  the isolation test embedded JSON-quoted paths into a JavaScript `-e` program.
  Replace executable interpolation with a fixed program reading JSON from stdin.
  All UID, capability, credential, peer-directory, database and network-escape
  assertions remain. A hostile path-string smoke test confirms paths remain data.
  The real namespace test must still pass in full canonical CI.

The old scan and its unresolved classifications remain recorded in
`SECURITY-SCAN-BASELINE.md`; these changes do not silently rewrite that history.

## Older review comments

- The SARIF extension-rule resolver defect was already fixed. Its 17 fail-closed
  parser tests still pass; real uploaded SARIF now reaches the severity policy.
- The cancellation warning in review 5546601546 is valid as a workflow design
  concern. Non-PR concurrency groups now include the exact commit SHA in both
  security/canonical workflows and the outer post-merge caller. Only superseded
  PR runs cancel in progress. This also avoids replacing pending checks for a
  different merged commit. Static workflow validation is not a demonstration of
  two live merges; no merge is performed for this test.
- "No blocking defects" reviews are observations for the reviewed scope, not
  proof that the entire import is secure. The separate security review found
  the confirmed helper issue afterward.
- The "too large for Bugbot" comment is a real coverage limitation. The full
  import was not proven reviewed merely because other automated reviews ran.
- The old CI-startup and initial default-setup failures are preserved history;
  later executed workflows and processed advanced CodeQL uploads supersede
  those infrastructure blockers, not the product security findings.

## Local validation and pending evidence

Passed: backend TypeScript build; changed-file formatting; 10 helper regression
tests; 17 launcher-safety tests; 17 SARIF-gate tests; static probe hostile-input
check; VERA emitted-code equivalence; actionlint and configured offline zizmor
checks. Full database, namespace, browser and native reruns are delegated to the
existing pinned GitHub canonical workflow, not claimed from local smoke tests.

No review thread is resolved, no alert dismissed, no gate lowered, and no merge,
model call, release or deployment is performed by these corrections.
