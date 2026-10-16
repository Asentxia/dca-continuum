# CodeQL alert triage — 10 October 2026

Scope: the three CodeQL alerts on main after PR #1. No billing, hosting, visibility, production qualification or frozen safety contracts changed.

## Alert 1 — fixture error disclosure

`tests/provider-emulator.ts` returned `String(e)` in a 500 response. Although this is an authenticated loopback fixture rather than a product server, errors must not be projected to its HTTP caller. Native Error conversion ordinarily exposes the message rather than the entire stack; the verified defect is internal exception-detail disclosure, not a demonstrated production stack leak.

The new controller regression requests an unsupported path with the fixture credential and requires the exact generic 500 response. Before the fix it failed with `Error: unsupported`. The fixture now returns only `Provider fixture request failed`. No exception contents are sent or logged by this handler.

## Alerts 2 and 3 — local Node probe, false positives

Both `js/bad-code-sanitization` findings are on the same namespace probe, at the separate interpolations of `JSON.stringify(secret)` and `JSON.stringify(peer.directory)` in `tests/computer-isolation.test.ts`.

The CodeQL query warns that JSON strings containing HTML closing tags can escape an enclosing script element. This code has no HTML or browser sink: `spawnSync` passes the constructed source directly as a single argument to the configured Node 24 executable through the reviewed namespace helper. It is not sent to a shell for reparsing. The values are a fixed local fixture secret path and a local driver-generated scratch directory. JSON encoding keeps quotes, backslashes and line breaks inside JavaScript string values; HTML tag characters have no special role in this Node invocation.

These are two source locations for one non-applicable HTML-script embedding pattern, not two demonstrated injection vulnerabilities. A separate report-only reviewer checked the source/sink and agreed with false-positive classification. The original credential/peer/database/network isolation assertions remain unchanged; no suppression, sanitizer substitution or test weakening was added.

References: [CodeQL improper code sanitization](https://codeql.github.com/codeql-query-help/javascript/js-bad-code-sanitization/), [CodeQL exception exposure](https://codeql.github.com/codeql-query-help/javascript/js-stack-trace-exposure/).

## Validation and release distinction

The reproduced failing regression and final affected/full-suite outputs are retained as ignored local evidence. The focused regression passed after the fix. The completed canonical run passed 188 backend groups, 26 frontend tests and 23/23 Chromium browser groups; qualification and release enforcement still exited 1 as required. The baseline expectation increases by exactly one for the new regression; zero-failure/skip assertions remain intact.

Scanner closure is reported separately from runtime test results; dismissing false positives is not a claim that all code is secure. Production remains BLOCKED, scheduler HELD, canary NO-GO. Merge requires owner approval.
