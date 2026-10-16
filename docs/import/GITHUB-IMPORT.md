# GitHub implementation import

## Source and history

This private-repository import combines the existing GitHub README history with the available recovered implementation history. No existing main commit is overwritten and no missing historical objects are invented.

- Original GitHub main: `b8a078fc218b4cbc6bda962c21a8e66b470a90cb`.
- Recovered audited implementation: `800091f08ce1eb8843813a8d48f681cd6a3ad5df`.
- Recovered source tree: `1fd20da4e313c888ee1a6a5b16e46de43bb57dcb`.
- Recovered canonical content digest: `a5bea9254bc74a390651315be4bf7334a34d89cea2d55142c0a12a9b979bce3b` across 313 scoped files.
- Recovered snapshot: 372 tracked files, 3,155,415 bytes, 21 executable files.
- `import/recovered-v7.1-audited` preserves the exact recovered commit. It is an audit reference, not a release.
- The original implementation README is retained as `docs/import/RECOVERED-README.md`. The existing GitHub README is retained with an import-status banner.

The integration commit and any CI adaptation have NEW commit/tree/digest identities and require fresh verification. Earlier results must not be represented as execution of the integration head. Complete original pre-recovery historical object provenance remains unavailable.

## Pre-push checks actually performed

- Checksum-verified Gitleaks 8.30.1 current tracked-export scan: PASS.
- Reachable implementation-history scan: PASS; a second scan without the existing exception file also reported zero findings. Gitleaks reported 98 non-merge commits scanned in the 121-commit available implementation history.
- Existing 32 exact historical Temporal fixture-token exceptions were not broadened.
- No tracked local databases, credentials, `.local`, dependency caches, generated build outputs, or runner archives were added. Historical development evidence remains only in the preserved history; it is not current independent execution evidence.
- Source-only NEXUS provenance verification: PASS for 154 retained complete license/notice texts, two donor-derived artifacts, and 104 pinned registry dependencies. This is not legal or security certification.
- Private destination and native Git read/push authorization were verified before upload. Credentials are outside the working tree and are not included in this repository.

## Existing independent execution evidence

The separate SENTINEL review at the recovered commit observed 29/29 browser checks passing after a runner-only private-network carrier correction, plus bounded backend, frontend, native and focused E2 passes. Full canonical acceptance did NOT pass: its live npm dependency audit failed at registry DNS resolution in that audit computer. Earlier browser failures and their scoped successful retest remain preserved in the independent audit record.

These are historical, source-bound results, not a GitHub CI pass. The registry audit must return a real result in the GitHub environment. Vulnerabilities or additional failures must be retained, not waived or replaced with a cache/coordinator result.

## Review and execution boundaries

- Import PR stays draft until the CI capability pilot is reviewed.
- Draft CI may perform secret scans, capability checks, provenance checks and actual dependency audits; it must not silently claim canonical qualification.
- Full canonical execution requires a verified disposable fixture environment, supported native/browser tools, correct online/offline behavior, scoped privilege helper, source identity capture and owned cleanup.
- No live provider/model credentials, Gemini calls, production access, deployment, push to main, automatic merge or release are part of this import.
- Existing automated WIP PR and repository automation are not merged or repurposed by this import.
- Durable E2 withdrawal journaling and restored-E2 recovery/reopening remain unimplemented or unqualified. Native screen-reader/actual browser-zoom and live integration qualification remain separate work.

**PRODUCTION: BLOCKED · SCHEDULER: HELD · CANARY: NO-GO. Owner acceptance remains required.**
