# Versioned adapter interfaces

Status: recommendation for review, written 2026-10-12 against `main`
`18dc8ce5531f7cf57e8f2c9a508c8339d164d4c1` (merge of pull request #22).
Publishing this document does not approve the change, authorize implementation,
copy donor source, start an adapter, or move a ledger.

Production stays BLOCKED. The scheduler stays HELD. Canary stays NO-GO.

## What this is

The next plan item after the merged tool-manifest slice is a versioned adapter
interface. Pull request #22 implemented the accepted tool-manifest
recommendation and nothing beyond that slice. Context and cognition binding
remains contract extension v3 from pull request #14. ENG-011 stays partial.
ENG-013 has not started.

This recommendation names the interface a later computation adapter must
implement. It does not implement that interface. It does not start the NEXUS
adapter. D05 still requires licensing and provenance evidence before any donor
copy. No donor tree is an input.

Today the only adapter interface in Continuum code is `ProviderAdapter` in
`src/provider-adapter.ts`: a provider name, `supports`, `send`, and `lookup`.
The fixed public GitHub read implements it. That read is not a protected write
and it is not a computation adapter. The interface has no version.
`ComputerDriver` is a placement driver. It is not this item.

Operation contract versions 1 through 4 pin the action binding. Version 2 adds
placement. Version 3 adds context and cognition. Version 4 adds the tool id and
tool revision. None of those versions pins an adapter interface. A tool
revision is not permission to call an adapter.

D01 requires restricted adapters. Workers and Focus Desk do not receive donor
management access or provider secrets. A computation token is not an effect
grant. The separate application workspace is not NEXUS isolation. Donor tests
do not close ENG-013 or ENG-014.

## The interface this recommendation names

One proposed interface id: `bounded-computation`. Version 1 is the contract
below. A later version is a separate reviewed extension. While no runtime
exists, naming the interface stores no operation, grant, or approval and does
not send. After a later accepted implementation, `bounded-computation` version
1 is the supported contract and is not rejected merely because the caller named
it. An unknown interface id or an unknown version fails closed and does not
send.

`bounded-computation` version 1 is the boundary ENG-013 will later implement.
A request may name only the tenant, a computation id, and the bounds already
required by that task: module, path, fuel, memory, timeout, and fork. The
result is local. It is not a provider observation, not `COMMITTED`, and not
verified external success.

The interface cannot mint a grant, an approval, a capability, or a provider
credential. It cannot send. It cannot admit a fact. A speculative branch does
not send. Rollback is local to the computation. A result that merely claims
success is not provider success. The Effect Controller remains the only sender.
PostgreSQL remains domain truth.

The existing `ProviderAdapter` stays the effect path. This recommendation does
not add a version field to it, does not change `send` or `lookup`, and does not
rewrite contract versions 1 through 4. An effect operation that does not name
`bounded-computation` keeps its current contract version.

The derived-memory boundary stays with ENG-019. This recommendation does not
specify it and does not start it. The D07 file-write adapter stays a separate
provider task. It is not `bounded-computation`.

## Smallest later change

A later implementation pull request, after this recommendation is accepted,
records the interface without a runtime and the fail-closed cases below. It
still does not start the NEXUS adapter and does not copy donor source.

That later pull request:

- Writes the version 1 contract for `bounded-computation` without a runtime.
- While no runtime exists, a caller that names `bounded-computation` stores no
  operation, grant, or approval, and it does not send.
- An unknown interface id or an unknown version fails closed and does not send.
  That denial stores no operation, grant, or approval, and it stays after a
  runtime exists.
- Leaves version 1, 2, 3, and 4 operation digests unchanged. It does not add
  contract version 5. It does not edit `docs/M1-SAFETY-CONTRACTS.md` or
  contract extensions v2, v3, or v4.
- Does not add a file from the NEXUS pin
  `e1c3d3c75d58f609c617e7a87cb05e84ea437d64` or the AEON-IQ pin
  `d5866e85edb3a7f7ea7186854655981ca73760f4`.

The no-runtime denial is not the rule for the supported contract. After a
later accepted implementation, `bounded-computation` version 1 is the supported
contract and is not rejected merely because the caller named it. Unknown
interface ids and unknown versions stay fail-closed and do not send.

This recommendation does not choose that pull request's files and does not add
them now. A stored interface row is not part of this proposal. If a later
review adds one, it may hold only the interface id, the version, and a
definition digest. It may not hold donor bytes, an executable schema, or
provider credentials. Rebuilding an index of those rows would create no grant,
approval, or operation.

## Acceptance tests

A later implementation is acceptable only when these hold on that commit:

1. Frozen M1 bytes and contract extensions v2, v3, and v4 stay unchanged.
   Existing version 1, 2, 3, and 4 operation digests stay unchanged. No
   contract version 5 is added.
2. While no runtime exists, a caller that names `bounded-computation` stores no
   operation, grant, or approval and does not send. It does not approve, admit
   a fact, load a module, or read a provider credential. The result is not
   `COMMITTED`. That denial does not stay in force after a later accepted
   implementation. `bounded-computation` version 1 is then the supported
   contract and is not rejected merely because the caller named it.
3. An unknown interface id or an unknown version fails closed and does not
   send, including after a runtime exists. The denial stores no operation,
   grant, or approval, and it does not approve, admit a fact, load a module,
   or read a provider credential. The result is not `COMMITTED`.
4. An operation that does not name the interface keeps its previous contract
   version. The existing effect-provider checks still apply. The public GitHub
   read still cannot write.
5. The tree contains no file copied from the NEXUS pin or the AEON-IQ pin.
   `qualification/PRODUCTION-GATES.json` and `docs/RELEASE-GATES.json` stay
   unchanged. Qualification enforcement and release enforcement still exit 1.

## Out of scope

This recommendation does not implement the interface. It does not add a
runtime, a migration, or a contract extension file.

These stay out of the later slice as well:

- Starting the NEXUS adapter, ENG-013, ENG-014, or any donor integration.
- Copying or distributing donor source. D05 still requires licensing and
  provenance evidence before any copy. Repository visibility and the product
  license stay as they are.
- The ENG-019 derived-memory interface, AEON-IQ, and admission of extracted
  facts.
- The D07 protected file-write adapter, live provider credentials, and a live
  send.
- A new operation contract version, a tool-manifest change, or a rewrite of
  context and cognition binding.
- `ComputerDriver`, managed hosts, and a scheduler choice. The scheduler stays
  HELD.
- Focus Desk screens and a product control that would call the interface.
- Any change to `qualification/PRODUCTION-GATES.json` or
  `docs/RELEASE-GATES.json`.

D01–D04 and the recorded D05–D12 directions stay inside the limits in
[OWNER-DECISIONS.md](OWNER-DECISIONS.md). This text does not close a missing
input, select a scheduler, or approve a live gate. Implementation waits for a
separate acceptance of this recommendation. Acceptance of this text is not
permission to start the NEXUS adapter.
