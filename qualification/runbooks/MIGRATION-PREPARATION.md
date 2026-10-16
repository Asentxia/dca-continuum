# M6/M7 preparation — activation prohibited

- Preserve accepted source pins and read-only history; reviewed repository mapping required.
- Dry-run identity mapping uses explicit approved tenant/principal/computer mappings, stable operation/provider IDs and source digests. Conflicts halt; possible partial effects become UNKNOWN. No grant, approval or provider call is imported automatically.
- Prepare non-effectful mapping/shadow comparisons only after required production gates and scheduler decision. A proposed admission is not an effect/completion proof.
- Before M7: owner-approved sole-principal scope, old sender frozen, old privileged credentials rotated, deployment/principal/placement fences advanced, verified backup/recovery inventory and real protected provider read-back. Never dual-write authority masters or keep a hidden legacy sender.
- Rollback stops new effects and reconciles UNKNOWN. It does not reactivate old credentials or resend on another transport.
- `canaryEligibility` rejects fixture PASS, PARTIAL, missing gates, HELD scheduler or missing/mismatched release-hash owner approval. Even an eligible review never deploys or executes by itself.
- All existing legacy guard patches remain un-applied. No GitHub push/PR, shadow deployment or canary was performed.

Current recommendation: NO-GO. `qualification/PRODUCTION-GATES.json` is the live-release ledger; local green tests never substitute for approved staging evidence.
