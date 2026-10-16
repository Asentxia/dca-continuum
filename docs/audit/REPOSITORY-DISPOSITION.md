# Canonical repository disposition

Reviewed starting commit: `3c197ddb57c13db397e30c48e4ceb6949d3a8ee9`. Every removed original byte is preserved in the verified archive; see [recovery](ARCHIVE-RECOVERY.md). No Git history was rewritten. The complete file-by-file disposition is delivered as an audit artifact, not another generated source snapshot.

| Starting path | Disposition | Dependency-based reason |
|---|---|---|
| `src`, `migrations`, `scheduler`, `web` | KEEP product | Runtime domain/controller/scheduler/Focus Desk source. Fixture-only implementations are isolated separately. |
| `tests`, required `tools` | KEEP engineering | Regression, migration, isolation, browser and validation harnesses. All output is ignored `.artifacts/` and uploaded by CI. |
| `canonical-evidence`, `evidence` | ARCHIVE outside product | Results/probes/repeated attempts, no required runtime imports. Script writers now generate fresh artifacts. |
| `implementation` | CONSOLIDATE + ARCHIVE | Current recovery contract/runbooks/configs moved; historical results/reports archived. |
| `qualification` | KEEP logic + CONSOLIDATE | Gate truth and enforcement kept byte-for-byte; disabled configs/runbooks normalized. Generated evidence archived. Ledger references to historical local results resolve through the archive, not fabricated fresh proofs. |
| `legacy-hotfixes` | ARCHIVE + minimum test fixtures | TS guards relocated; only immediate Python refusals extracted. Legacy code/patch remains recoverable, never product runtime. |
| `docs/archive`, old packet wrappers | ARCHIVE | Competing handoff wrappers/historical reports, not current developer entry points. |
| `docs/interface-source` | CURRENT contract/plan moved | Sole approved product interface and plan retained under `docs/interface`; canonical traceability/gaps remain current. |
| `docs/design-source` | CURRENT design moved + ARCHIVE | Approved Focus Desk design retained; superseded packets/source copies archived. |
| `docs/PROVISIONAL-TARGET.md` | KEEP approved target | Still the detailed approved requirement/migration source, distinct from implemented topology. It is not automatically canon or proof of implemented features. |
| Handoff root manifests/start files | ARCHIVE | Archive checksum/commit preserves reproducibility. `README.md` is the sole developer entry point. |
| `internal/operator` | KEEP internal test-only pending hardening | Cancellation/context-release regression behavior is not implied available in the primary console. It must never be a public deployment route. |
| `OWNER-ACTION-CHECKLIST.md` | KEEP current | One owner checklist; no copied historical checklists. |

Removal was preceded by literal reference/import/script inspection; concrete test-fixture dependencies were moved, not discarded. Full cleanup regression must pass before a merge recommendation.
