# Safe local test entry point

Run `tools/local-test.py` inside the correct Linux environment. Windows users invoke
it through the explicitly selected WSL distribution and Linux user. It does not
install runtimes, start databases, alter sudo/helper settings, or stop shared services.

Copy `tools/local-test-profile.example.json` to a private location outside Git and
replace its four paths with verified Linux paths. Keep accounts, passwords and
machine-specific paths out of the repository. Current CI pins are Node 24.14.1
backend and Node 22.23.3 frontend. PostgreSQL follows CI's major-17 policy; its
packages are not pinned to one minor. Exact binary and server versions are recorded.
Update launcher pins alongside CI
when a runtime upgrade is approved. See `docs/TESTING.md` for canonical semantics.

```sh
python3 tools/local-test.py check --profile /private/location/profile.json
python3 tools/local-test.py focused --profile /private/location/profile.json event-envelope.test.js
CT_RESET_LOCAL_FIXTURE=yes CT_RESET_CONSOLE_FIXTURE=yes \
  python3 tools/local-test.py canonical --profile /private/location/profile.json
```

`check` reads configuration/runtime/database state only. It requires the fixture
server on loopback port 55432 to already belong to this checkout's `.local/pgdata`,
and the restricted helper to point to its `.local/computer-fixtures` and match the
current repository helper bytes. Symlink
workarounds are refused. A foreign cluster or helper root produces a refusal;
coordinate a separately authorized fixture handover instead of taking it over.

`focused` compiles then runs only the named `dist/tests/*.test.js` files. Individual
tests may modify the owned disposable fixture: inspect their prerequisites first.
`canonical` invokes the existing canonical runner with both explicit reset flags.
Neither mode installs dependencies; prepare the locked dependencies separately.

Test modes hold a cooperative per-user Linux file lock across all worktrees and
refuse other database client sessions. Legacy commands, other users and separate
Linux/WSL environments do not honor this lease. It cannot prevent a new external
client from connecting after preflight. Schedule exclusive local testing; it is
not a replacement for database access controls or the scripts' ownership checks.

Interrupted launches terminate only their own foreground process group and release
the lease. The existing owned database is retained. Detached fixture children remain
the responsibility of the existing test harness; the launcher performs no broad
process cleanup. Never shut down WSL to clear a test run.

Evidence is private, ignored `.artifacts/local-launcher/<run>/`: test log, status,
runtime versions, Git head and source fingerprints before/after. The fingerprint
includes uncommitted implemented source; a Git head alone does not prove those bytes.
Source changes fail the launch. Interruptions retain INCOMPLETE evidence. Logs must
be reviewed/redacted before publication. SIGKILL/power loss cannot guarantee a final
report or child cleanup. Normal tests and production gates are unchanged.

Launcher regression checks require no live database:
`python3 -m unittest discover -s tools -p test_local_test.py`.
