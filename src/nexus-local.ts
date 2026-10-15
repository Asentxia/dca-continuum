/** Explicit opt-in local profile, not a replacement for the opaque recording API.
 * No effect/provider/DB dependency. Guest output is untrusted local computation.
 */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const NEXUS_LOCAL_PROFILE = 'nexus-local-i32-v1' as const;
export const NEXUS_LOCAL_AUDIENCE = 'urn:continuum:nexus-local';
export const NEXUS_LOCAL_TOKEN_TYPE = 'continuum-nexus-local+jwt';
export type NexusResult =
  | Readonly<{
      status: 'LOCAL_RESULT';
      scope: 'LOCAL_ONLY_NOT_PROVIDER_OBSERVATION';
      value: number;
      fuelConsumed: number;
      moduleSha256: string;
    }>
  | Readonly<{ status: 'DENIED' | 'FAILED'; reason: string }>;
export interface NexusLocalOptions {
  profile: typeof NEXUS_LOCAL_PROFILE;
  /** Trusted deployment path, never a worker field. Must be prebuilt offline. */
  executable: string;
  /** Trusted canonical verifier/enrollment composition; NEVER supplied by worker. */
  verifyCredential: (credential: string) => Promise<NexusVerifiedCaller>;
  /** Required current enrollment/revocation/module-policy check before EACH spawn. */
  authorize: (binding: NexusAuthorizationBinding) => Promise<boolean>;
  modules: readonly Readonly<{
    tenant: string;
    id: string;
    bytes: Uint8Array;
  }>[];
}
export type NexusVerifiedCaller = Readonly<{ subject: string; tenant: string }>;
export type NexusAuthorizationBinding = Readonly<{
  caller: NexusVerifiedCaller;
  computationId: string;
  module: string;
  moduleSha256: string;
  path: string;
  fuel: number;
  memory: number;
  timeout: number;
}>;
interface Request {
  tenant: string;
  computationId: string;
  module: string;
  path: string;
  fuel: number;
  memory: number;
  timeout: number;
  fork: false;
}
const fields = [
  'tenant',
  'computationId',
  'module',
  'path',
  'fuel',
  'memory',
  'timeout',
  'fork',
];
const id = (x: unknown): x is string =>
  typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const integer = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= lo && x <= hi;
const deny = (reason: string): NexusResult => ({ status: 'DENIED', reason });
const failed = (reason: string): NexusResult => ({ status: 'FAILED', reason });
const nativeReasons = new Set([
  'INVALID_REQUEST',
  'RUNTIME_UNAVAILABLE',
  'INVALID_MODULE',
  'IMPORT_DENIED',
  'RESOURCE_LIMIT',
  'ENTRYPOINT_DENIED',
  'FUEL_EXHAUSTED',
  'TIMEOUT',
  'TRAP',
]);

/** The only exported executable port requires a cryptographically verified token.
 * No API accepts a caller-selected actor/tenant. Host owns verifier + policy callbacks.
 * This port does not introduce an enrollment/grant authority or verify JWTs itself.
 * Composition MUST use canonical identity verification + current enrollment/policy.
 * Fixture credentials in tests demonstrate compute only, never real VERA enrollment.
 * Local credentials are NOT Effect Controller capabilities and cannot authorize sends.
 */
export function createNexusLocalIngress(options: NexusLocalOptions) {
  if (
    options.profile !== NEXUS_LOCAL_PROFILE ||
    !isAbsolute(options.executable) ||
    typeof options.verifyCredential !== 'function' ||
    typeof options.authorize !== 'function'
  )
    throw Error('invalid nexus host configuration');
  const executable = options.executable;
  const verifyCredential = options.verifyCredential;
  const authorize = options.authorize;
  const modules = new Map<string, { bytes: Buffer; sha256: string }>();
  if (options.modules.length > 32) throw Error('nexus registry capacity');
  for (const m of options.modules) {
    if (
      !id(m.tenant) ||
      !id(m.id) ||
      !(m.bytes instanceof Uint8Array) ||
      m.bytes.length < 8 ||
      m.bytes.length > 65536 ||
      Buffer.from(m.bytes.subarray(0, 4)).toString('hex') !== '0061736d'
    )
      throw Error('invalid nexus module');
    const key = `${m.tenant}:${m.id}`;
    if (modules.has(key)) throw Error('duplicate nexus module');
    const bytes = Buffer.from(m.bytes); // Registry mutation cannot replace admitted bytes.
    modules.set(key, {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  let active = false;
  return Object.freeze({
    profile: NEXUS_LOCAL_PROFILE,
    async execute(
      credential: unknown,
      interfaceId: unknown,
      version: unknown,
      input: unknown,
    ): Promise<NexusResult> {
      // Unknown contracts fail closed before request inspection or credential I/O.
      if (interfaceId !== 'bounded-computation')
        return deny('UNSUPPORTED_INTERFACE');
      if (version !== 1) return deny('UNSUPPORTED_VERSION');
      if (typeof credential !== 'string' || credential.length > 8192)
        return deny('UNAUTHENTICATED');
      let caller: NexusVerifiedCaller;
      try {
        const verified = await verifyCredential(credential);
        if (
          !verified ||
          typeof verified.subject !== 'string' ||
          !verified.subject ||
          verified.subject.length > 255 ||
          !id(verified.tenant)
        )
          return deny('UNAUTHENTICATED');
        caller = Object.freeze({
          subject: verified.subject,
          tenant: verified.tenant,
        });
      } catch {
        return deny('UNAUTHENTICATED');
      }
      const tenant = caller.tenant;
      // Only JSON-like own data properties: no getters/proxies accepted as trusted data.
      let r: Request;
      try {
        if (
          !input ||
          typeof input !== 'object' ||
          Object.getPrototypeOf(input) !== Object.prototype
        )
          return deny('INVALID_REQUEST');
        const ds = Object.getOwnPropertyDescriptors(input);
        if (
          Reflect.ownKeys(ds).length !== fields.length ||
          fields.some((k) => !ds[k] || !('value' in ds[k]))
        )
          return deny('INVALID_REQUEST');
        r = Object.fromEntries(
          fields.map((k) => [k, ds[k].value]),
        ) as unknown as Request;
        if (
          !id(r.tenant) ||
          !id(r.computationId) ||
          !id(r.module) ||
          !id(r.path) ||
          !integer(r.fuel, 1, 100_000_000) ||
          !integer(r.memory, 65536, 16 * 1024 * 1024) ||
          r.memory % 65536 !== 0 ||
          !integer(r.timeout, 1, 1000)
        )
          return deny('INVALID_REQUEST');
        if (r.tenant !== tenant) return deny('TENANT_MISMATCH');
        if (r.fork !== false) return deny('FORK_UNSUPPORTED');
      } catch {
        return deny('INVALID_REQUEST');
      }
      const module = modules.get(`${tenant}:${r.module}`);
      if (!module) return deny('MODULE_DENIED');
      try {
        const allowed = await authorize(
          Object.freeze({
            caller,
            computationId: r.computationId,
            module: r.module,
            moduleSha256: module.sha256,
            path: r.path,
            fuel: r.fuel,
            memory: r.memory,
            timeout: r.timeout,
          }),
        );
        if (allowed !== true) return deny('NOT_AUTHORIZED');
      } catch {
        return deny('AUTHORIZATION_UNAVAILABLE');
      }

      if (active) return deny('BUSY');
      active = true;
      try {
        return await invoke(executable, r, module);
      } finally {
        active = false;
      }
    },
  });
}

function invoke(
  executable: string,
  r: Request,
  module: { bytes: Buffer; sha256: string },
): Promise<NexusResult> {
  return new Promise((resolve) => {
    // Linux fixture/deployment boundary. No shell, environment, inherited cwd,
    // runtime dependency downloads or file descriptors other than stdio pipes.
    const child = spawn(
      '/usr/bin/prlimit',
      [
        '--as=1073741824',
        '--cpu=2',
        '--fsize=0',
        '--core=0',
        '--nofile=32',
        '--',
        executable,
      ],
      { cwd: '/', env: {}, shell: false, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = Buffer.alloc(0);
    let failure: string | undefined;
    let settled = false;
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('TIMEOUT'), r.timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 1024) {
        stop('OUTPUT_LIMIT');
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.stdin.on('error', () => {
      /* close/error controls the final outcome */
    });
    child.on('error', () => {
      failure ??= 'RUNTIME_UNAVAILABLE';
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); // Return only after process exit/reap, never detach a timeout.
      if (failure) {
        resolve(failed(failure));
        return;
      }
      if (signal || code !== 0) {
        resolve(failed('NATIVE_FAILURE'));
        return;
      }
      try {
        const reply = JSON.parse(output.toString('utf8'));
        const keys = Object.keys(reply).sort().join(',');
        if (
          reply.status === 'LOCAL_RESULT' &&
          keys === 'fuelConsumed,status,value' &&
          integer(reply.value, -2147483648, 2147483647) &&
          integer(reply.fuelConsumed, 0, r.fuel)
        ) {
          resolve({
            status: 'LOCAL_RESULT',
            scope: 'LOCAL_ONLY_NOT_PROVIDER_OBSERVATION',
            value: reply.value,
            fuelConsumed: reply.fuelConsumed,
            moduleSha256: module.sha256,
          });
          return;
        }
        if (
          reply.status === 'FAILED' &&
          keys === 'reason,status' &&
          nativeReasons.has(reply.reason)
        ) {
          resolve(failed(reply.reason));
          return;
        }
      } catch {
        /* No raw native diagnostics or guest data in failures. */
      }
      resolve(failed('INVALID_NATIVE_REPLY'));
    });
    child.stdin.end(
      JSON.stringify({
        wasm: [...module.bytes],
        path: r.path,
        fuel: r.fuel,
        memory: r.memory,
        timeout: r.timeout,
      }),
    );
  });
}
