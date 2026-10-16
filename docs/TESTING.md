# Reproducible validation and evidence

Use the prerequisite/setup commands in the root README. `npm ci --ignore-scripts` installs the exact lockfile; backend and frontend intentionally use different Node major versions. Never use live credentials or a production database.

`CT_RESET_LOCAL_FIXTURE=yes CT_RESET_CONSOLE_FIXTURE=yes npm run test:canonical` runs the accepted backend baseline, native local HA/PITR and minimum legacy refusal fixtures; fresh console contracts/semantics/security tests; frontend typecheck/unit tests; ordinary product and dedicated local-test builds; Chromium integration/accessibility/performance checks; dependency audit; unchanged qualification/release enforcement. Every raw result is retained under `.artifacts/`. The final machine summary records measured counts. The historical label of 121 groups is not the current assertion; `tools/summarize-canonical-evidence.py` checks the measured total.

Optional `CT_RUN_PUBLIC_READ_FIXTURE=yes` includes the fixed public immutable GitHub GET contract. No protected provider mutation, live identity, cloud DR or compressed substitute for a 24-hour test is allowed. Ordinary PR CI does not require public-provider availability or live secrets.

Qualification/release enforcement deliberately exits **1** while production gates remain blocked; an unexpected success is an error. Those scripts must not be edited to make local CI look green. Ledger/schema/invariant checks and raw output are separate from release eligibility.

## Artifact policy

- `.artifacts/canonical/final/` — aggregate validation and source fingerprint.
- `.artifacts/implementation/` — baseline/local native DR/fixture evidence.
- `.artifacts/core/` — process/race/controller fixture results.
- `.artifacts/qualification/` — qualification enforcement/public-read output.
- `.artifacts/audit/` — security regressions, pre-fix failures and reviews.

CI uploads sanitized outputs even when tests fail. It never uploads `.local/`, database/WAL/dumps, installed dependencies, private keys, cookies, bearer tokens or worker identity arguments. Historical evidence is preserved by the archive manifest and unchanged Git history, not `git restore` operations during tests.

## Interpretation

Axe selected-rule checks and browser keyboard/reflow probes are local evidence, not a WCAG conformance certificate. Native screen-reader/browser-chrome zoom and independent security review remain NOT RUN. Local namespace/process/PITR tests do not qualify cloud/VM/region behavior. Dependency scanning is not a code/security certification.
