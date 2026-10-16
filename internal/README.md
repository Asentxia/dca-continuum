# Internal fixtures — never product entry points

`fixtures/` contains the local signed-identity/provider/domain-server executables. `operator/` is the historical operator regression harness, not an administrative production console. These paths are excluded from `tsconfig.product.json` and from the Next product application/routes.

The only supported product UI is Focus Desk under `web/`. Internal fixture code requires an explicit local trust profile; staging/production must reject it. Cancellation and exact quarantined-context release remain backend-tested/internal fixture behaviors; neither is silently made a public control.

No live credentials or real account mutation may be used here. Do not deploy the development `dist/` tree; `build:product` produces the fixture-free backend tree.
