# Continuum — First Production Qualification Gates

Production: BLOCKED. Canary: NO-GO. Final scheduler: HELD.

Read `docs/PRODUCTION-QUALIFICATION-RESULT.md` and `PRODUCTION-GATES.json`. New identity/authority/renewal code is production-oriented but **not live IdP or deployment qualified**. Actual provider testing is public GitHub GET only, not protected writes. Test issuer/private keys are generated in memory and not packaged. The accepted original baseline ZIP and frozen contract remain unchanged.

## Reproduce these implementation checks
Linux/Node24/Python3.13/PostgreSQL17/sudo+network namespaces required. Install deps, restore executable bits if your ZIP extractor dropped them, then:

```sh
npm ci --ignore-scripts --ignore-scripts
chmod +x tools/*.sh qualification/*.sh
CT_RESET_LOCAL_FIXTURE=yes bash qualification/run-first-gates.sh
python3 qualification/check-gates.py --enforce  # EXPECTED EXIT 1
pg_ctl -D .local/pgdata stop -m fast
```

Only the project's own loopback PostgreSQL fixture databases ct_test and ct_restore are reset. Never use a real cluster for this command. Tests call the public GitHub API at a fixed repository/commit, with bounded GET requests; failures around those reads are deliberately client-injected. Network availability/rate limits are required, not ignored. No cloud resource or mutable provider object is created. The inherited `npm test` is the baseline harness; use the qualification command for the new suites.

`qualification/config/IDENTITY-STAGING.json` remains disabled. Do not deploy fixture trust authentication, HMAC compatibility, test keys, HTTP listeners, privileged fixture roles or static history capabilities as production setup. Missing staging values are not guessed.

Raw logs and response metadata/bodies are under `qualification/evidence`. Older `.artifacts/core/` material is retained historical baseline evidence, not a newly passed production suite. Partial gates stay PARTIAL.
