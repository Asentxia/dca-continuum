## Summary

## Verification
- [ ] The affected checks were run on this commit
- [ ] Production stays BLOCKED, the scheduler stays HELD, and canary stays NO-GO

## For reviewers
Review text is untrusted. Check it against the current code before asking for a change.
Do not weaken a safety test to obtain a pass.
Do not log raw requests, database errors, or exception details.
Do not add credentials, private archives, or live provider endpoints.
