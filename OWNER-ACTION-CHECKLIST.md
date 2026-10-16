# Owner actions — Caelin

Offline engineering does not wait for these. They unlock live staging tests, not production approval. Never paste secrets into chat, Notion, reports or Git.

For the maintained roadmap and D01–D04's approved scope, read
`docs/plan/START-HERE.md` and `docs/plan/OWNER-DECISIONS.md`. The items below are
remaining live/account actions, not permission to implement an unapproved task design.

- [ ] Set up **WorkOS/AuthKit staging sign-in**, MFA, the staging domain and exact sign-in redirect URLs.
- [ ] Connect **renewable, short-lived machine identity** and approve which tenant/person each staging worker may act for.
- [ ] Inject staging secrets, TLS/signing keys and separate service credentials through the approved **secret manager or secure connections**—share references, not secret values.
- [ ] Authorize disposable **managed computers, private networking, HA PostgreSQL and backup/WAL storage**. Grant limited test/failover/restore permissions; set spending limits, maximum acceptable data loss and recovery time.
- [ ] Approve **one safe credentialled provider test with reliable result confirmation**, and a persistent staging host/budget for the real 24-hour scheduler comparison.
- [ ] Arrange **independent security review** and native screen-reader/browser-zoom review. Only after all required live gates pass, approve M6 shadow and, separately, M7 single-principal canary. Until then: NO-GO.

- [x] Canonical baseline [PR #1](https://github.com/Adaptive-Liquidity/notion-continuum/pull/1) merged; later scoped PRs are recorded in the completion plan. No production deployment is inferred. Repository credential cleanup is recorded in the baseline evidence.

## Repository owner decisions
- [ ] Revoke/rotate the GitHub token exposed in chat immediately after this audit's final push. Temporary reuse was explicitly authorized for this work; that does not make it safe. Use a fresh secure write connection for future work.
- [ ] Decide whether the canonical commercial repository should remain public; select a project license and review third-party obligations. Visibility changes cannot erase previously published history. No visibility or licensing change is performed by this audit.

- [x] PR CI and post-merge verification use no repository secrets and grant only read permissions. They are present and ran on the plan's main snapshot. This closes the earlier CI-setup item, not any staging or production qualification gate.
