# Initial CodeQL baseline — unresolved disposition

Source reviewed: PR 2 head 80872185a383e224457d84706209171562e9517a,
with its verified GitHub merge candidate. Private raw SARIF is retained by Security
verification run 38888304985. No scanner finding has been suppressed or waived.

| Rule | Reported severity | Location | Bounded static observation | Disposition |
| --- | --- | --- | --- | --- |
| js/insufficient-password-hash | 8.1 (high) | src/db.ts:4; flows from src/regency/vera-service.ts | SHA-256 is used for a canonical evidence-chain digest. The reported sources are spreads of noAuthority (three constant false authority flags), not an observed password value. This suggests a false-positive source classification; it is not proof that every caller of sha is safe. | Remains merge-blocking pending an evidence-backed, narrowly scoped disposition or correction. No password-hashing algorithm change is made. |
| js/bad-code-sanitization (two results) | 6.1 (medium) | tests/computer-isolation.test.ts:243 | Local isolation-test probe construction interpolates JSON.stringify paths and an isolation UID. Requires contextual review; not independently demonstrated as exploitable. | Retained; not silently promoted to a confirmed product vulnerability or discarded. |

The SARIF adapter was corrected to resolve CodeQL query-pack extension rules,
including their component/index references. Unknown/malformed references fail
closed. The high-severity result remains visible to the gate after that correction.
Neither user technical sign-off nor broad query/path exclusions are requested.
These are scanner findings and bounded source observations, not an independent
security certification. Production qualification remains blocked separately.
