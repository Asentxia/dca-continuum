# Recovery contract extension — validation revision 0.2

The frozen M1 source is unchanged. This explicit extension covers a case its normal runtime transition list could not represent: a physical/PITR restore can contain REQUESTED even though the provider performed the effect after the backup.

Only the separate trusted recovery role, while an independently fenced recovery run is BLOCKED, may classify restored REQUESTED as UNKNOWN. It cannot return UNKNOWN to a sendable state, change the immutable binding, mint write authority, or interpret missing read-back as no effect. Ordinary controller/API roles cannot take this transition.

A recovered domain stays closed until a separately authenticated recovery operator reapplies the independently retained revocation journal, classifies and verifies the provider gap, and obtains approval bound to the complete recovery manifest. An external fence activates last; failure stays closed. Old epochs and immutable bindings do not silently become current.

The local fence-file adapter is an offline fixture, not distributed cloud fencing. Multi-tenant/global recovery needs an independently enrolled cluster operator; a tenant owner is not automatically such an operator. The policy callback is mandatory. Staging must use a separately administered conditional store and real operator approval, not the fixture approval helper.

Completeness of remote effect inventories, records created after the backup, external journal retention and regional split-brain remain live qualification requirements. A local chain or an empty journal is not proof of those facts. No automatic activation is deployed.
