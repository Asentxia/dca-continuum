# Canonical cleanup disposition

All original 975 tracked files (9,440,766 bytes) at `3c197ddb57c13db397e30c48e4ceb6949d3a8ee9` were recoverable in verified source/evidence ZIP and Git bundle **before** cleanup. Original hashes, archive checksums and recovery details are in `ARCHIVAL-MANIFEST.json` and `ARCHIVE-RECOVERY.md`. Git history is unchanged. Exact per-path before/after dispositions and sizes are delivered as audit artifacts rather than hundreds of generated files in Git.

| Major path/material | Classification | Reason / dependency check |
|---|---|---|
| `src/`, `migrations/`, current `scheduler/`, `web/` | KEEP — canonical product source | Runtime/domain/frontend contracts; fresh builds and regressions pass |
| `tests/`, necessary `tools/`, lockfiles/configs | KEEP — canonical engineering/test infrastructure | Reproducible validation, refusal/fault/race/DR/isolation; imports and scripts updated and tested |
| `qualification/` code/gates/current runbooks/configs | KEEP — current qualification infrastructure/docs | Live truth unchanged; disabled staging references retain safety information |
| Current architecture/safety/product contract/design/traceability/gaps | KEEP — current documentation | Sole current authoritative requirements retained, not competing historical products |
| `internal/fixtures`, `internal/operator` | KEEP — internal-only tool | Test executable isolation; six operator regressions and three actual product-isolation checks; not product routes |
| Six old static-capability scheduler-spike modules | MOVE — explicit `tests/fixtures/legacy-scheduler/` | Historical comparator retained for engineering tests, not current product progression |
| `canonical-evidence/`, `evidence/`, `implementation/evidence/`, `qualification/evidence/` generated results | ARCHIVE OUTSIDE PRODUCT TREE | Original runs/probes/screenshots preserved; no runtime dependency; fresh results use ignored `.artifacts/` |
| `implementation/docs/`, `implementation/infra/`, `qualification/infra/` | MOVE CURRENT / ARCHIVE DUPLICATES | Current recovery/staging/migration/scheduler runbooks/configs consolidated into `docs/` and `qualification/` |
| `legacy-hotfixes/` | ARCHIVE / EXTRACT MINIMUM REFUSAL FIXTURES | Original complete patches archived; two TS and two exact Python refusal fixtures retained under tests; fresh regression/probes pass |
| `docs/archive`, source-packet wrappers and superseded reports | ARCHIVE OUTSIDE PRODUCT TREE | Sole current product contract/plan/Focus Desk direction moved into `docs/interface/`; current architecture and detailed provisional target preserved |
| Handoff root manifests/start-here/delivery/import/publication reports | REMOVE FROM ACTIVE REPOSITORY after archival | README is the single developer entry point; verified recovery metadata lives under `docs/audit/` |
| Generated `web/next-env.d.ts` | TRACKED GENERATED GLUE | Remains in the tracked tree as Next.js type glue and is excluded from the tested-source fingerprint. Static `web/env.d.ts` remains. |
| Earlier security self-review | ARCHIVE / SUPERSEDE | Current principal review replaces obsolete test-count findings, not independent clearance |
| Public/commercial licensing, temporary exposed GitHub credential, CI activation | REQUIRES OWNER DECISION | No visibility/licensing/history changes; rotate credential; approve/apply/run credential-free CI |

Checks before removal: literal imports/references, scripts, test dependencies, current authoritative-document references and safety-contract uses. Archive verification preceded deletions. Product builds and the complete fresh suite verify no moved source was accidentally lost. The original frozen safety contract is byte-identical. No package, legacy tool or document was removed solely based on its name.

Not all archived content was useless: it is historical audit evidence with an exact recovery path. It does not belong in the active long-term product tree. New generated test results are never a substitute for retained original evidence or real live gates.
