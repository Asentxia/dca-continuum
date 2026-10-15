/**
 * In-memory record of the bounded-computation v1 proposal; not an operation
 * contract version, persisted registry, executable schema, or runtime.
 *
 * The accepted field vocabulary does not specify requiredness, value types,
 * module/path authorization, units, or quantitative limits. Recording it does
 * not provide operational validation. Request values therefore stay opaque.
 */
export const BOUNDED_COMPUTATION_V1 = Object.freeze({
  id: 'bounded-computation',
  version: 1,
  allowedRequestFields: Object.freeze([
    'tenant',
    'computationId',
    'module',
    'path',
    'fuel',
    'memory',
    'timeout',
    'fork',
  ] as const),
  implementation: 'RECORDING_AND_DENIAL_ONLY',
  operationalValidation: 'UNSPECIFIED',
  resultScope: 'LOCAL_ONLY_NOT_PROVIDER_OBSERVATION',
} as const);

/**
 * Local denials, never persisted operation states or provider observations.
 * Permanence distinguishes an unsupported contract from this slice's missing
 * runtime; it is not a retry policy or a promise of a future implementation.
 */
export type BoundedComputationDenial = Readonly<
  | { status: 'DENIED'; reason: 'NO_RUNTIME'; permanent: false }
  | {
      status: 'DENIED';
      reason: 'UNSUPPORTED_INTERFACE' | 'UNSUPPORTED_VERSION';
      permanent: true;
    }
>;

const noRuntime = Object.freeze({
  status: 'DENIED',
  reason: 'NO_RUNTIME',
  permanent: false,
} as const);
const unsupportedInterface = Object.freeze({
  status: 'DENIED',
  reason: 'UNSUPPORTED_INTERFACE',
  permanent: true,
} as const);
const unsupportedVersion = Object.freeze({
  status: 'DENIED',
  reason: 'UNSUPPORTED_VERSION',
  permanent: true,
} as const);

/**
 * Resolve only the exact interface id and numeric version, without coercion.
 * A later accepted runtime may replace NO_RUNTIME for the known contract only;
 * unknown ids and versions remain permanently unsupported.
 */
export function resolveBoundedComputation(
  interfaceId: unknown,
  interfaceVersion: unknown,
): BoundedComputationDenial {
  if (interfaceId !== BOUNDED_COMPUTATION_V1.id) return unsupportedInterface;
  if (interfaceVersion !== BOUNDED_COMPUTATION_V1.version)
    return unsupportedVersion;
  return noRuntime;
}

/**
 * Recording/denial boundary only. Do not inspect, normalize, retain, or echo
 * the request, authenticate its tenant, load its module/path, or call a hook.
 * There are no imports, callbacks, stores, credentials, or provider I/O here:
 * no operation, grant, approval, capability, or fact can be created.
 */
export function requestBoundedComputation(
  interfaceId: unknown,
  interfaceVersion: unknown,
  _request: unknown,
): BoundedComputationDenial {
  return resolveBoundedComputation(interfaceId, interfaceVersion);
}
