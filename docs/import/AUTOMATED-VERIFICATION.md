# Automated verification rollout

## Approved scope

Repository: Asentxia/dca-continuum. No deployment, live model calls, product
acceptance, or policy weakening is authorized by this rollout. No human code-review
approval is assigned to the owner. Zero required human approvals is a practical
solo-maintainer configuration, not a claim of independent human review.

## Enforcement

The active main ruleset requires a PR, resolved conversations, current checks,
canonical verification, secret scanning, and dependency review. Force-push/deletion
are blocked. No bypass actors are configured. New check contexts are enrolled only
after their actual execution and baseline inspection. Do not label absent scans PASS.

## Added checks

- Full canonical verification and a success-only merge gate.
- Canonical checkout is the GitHub PR merge candidate, not only PR head.
- SHA-pinned CodeQL for JavaScript/TypeScript, Python, and Actions.
- A fail-closed CodeQL alert gate checks processed results for the exact ref and
  blocks open high/critical security alerts or error-level findings. Scan completion
  alone is not interpreted as absence of vulnerabilities.
- Checksum-pinned actionlint and zizmor workflow checks.
- Pinned cargo-audit and weekly Rust dependency updates.
- Security workflow runs on PR, merge group, main push, and weekly schedule.
- Automatic Dependabot security updates enabled separately through repository API.

Rust CodeQL coverage is not claimed by this configuration. Native behavior remains
covered by canonical tests and native dependency advisories. No CODEOWNERS review
requirement is invented without a qualified owner/team.

## AI rollout remains disabled

Gemini and Codex calls require separately configured provider credentials, approved
models, and a verified shared monthly USD 15 budget mechanism (USD 7.50 per provider
initial allocation). No provider key, model invocation, or AI review pass is created
by these workflows. Alerts alone are not hard caps. A bounded provider proxy must
reserve the worst-case request cost, serialize ledger updates, reconcile actual
usage, and fail closed when rates/quota/accounting are unavailable. Provider billing
controls must be independently checked before activation. AI outputs are untrusted,
advisory, and cannot approve/merge/deploy. A review must bind to an exact commit;
missing or truncated context cannot be presented as a complete review.

Unresolved actionable AI findings will require correction and retesting or qualified
escalation, not a technical decision by the owner. The automated AI findings gate is
not active before the reviewer/accounting path is implemented and tested.

## Unchanged limits

The E2 durable withdrawal/restore gap, historical provenance limits, and production
qualification remain separate. Existing post-merge evidence reuse must be tightened
before new scans are eligible for reuse. This rollout does not grant production
approval or certify the absence of security flaws.
