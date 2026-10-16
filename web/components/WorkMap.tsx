'use client';
import React, { useId } from 'react';
import {
  EnvelopeSchema,
  Identifier,
  OperationStateSchema,
  type ConsoleItem,
  type ReadEnvelope,
} from '@continuum/contracts';

export interface WorkMapProps {
  envelope: Readonly<ReadEnvelope> | null;
  loading: boolean;
  stale: boolean;
  offline: boolean;
  readUnavailable: boolean;
  selectedTaskId?: string;
  onInspectTask: (taskId: string) => void;
}

const unknown = 'UNKNOWN — metadata unavailable';
const omitted = new Set([
  '[Redacted]',
  '[Sensitive value omitted]',
  '[Depth limit]',
]);
// These are the current server's workPhase labels, not workflow stages.
const phases = new Set([
  'Cancelled before later admission; in-flight effects may finish',
  'Outcome uncertain',
  'Blocked',
  'Executing',
  'Effects verified — goal review required',
  'Pending exact review',
  'Planned — no workflow admitted',
]);
const labels: Record<string, string> = {
  REQUESTED: 'Pending',
  RESERVED: 'Preparing — reserved',
  SENDING: 'Executing — awaiting observation',
  UNKNOWN: 'Outcome uncertain',
  DENIED: 'Denied',
  FAILED_KNOWN_NO_EFFECT: 'Failed — known no effect',
};
type Operation = {
  key: string;
  id: string;
  state: string | null;
  digest: string | null;
  label: string;
  verified: boolean | null;
  verificationScope: string | null;
  unavailable: boolean;
  conflict: boolean;
};
type Task = {
  key: string;
  id: string;
  title: string;
  phase: string;
  revision: string;
  coordination: Record<string, string>;
  dependencies: string[];
  dependenciesKnown: boolean;
  operations: Operation[];
  operationsKnown: boolean;
  factsKnown: boolean;
  conflict: boolean;
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    Identifier.safeParse(value).success
  );
}
function opaqueIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 4096 && value.trim().length > 0
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !omitted.has(value.trim())
  );
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function same(a: unknown, b: unknown) {
  // Only our normalized primitive/array models reach this comparison.
  return JSON.stringify(a) === JSON.stringify(b);
}
function operation(value: Record<string, unknown>): Operation {
  const id = value.id as string;
  const state = OperationStateSchema.safeParse(value.state);
  const digest =
    typeof value.digest === 'string' &&
    value.digest.length === 64 &&
    /^[a-f0-9]{64}$/.test(value.digest)
      ? value.digest
      : null;
  const committed = value.state === 'COMMITTED';
  const scope = value.verificationScope;
  const expectedLabel = committed
    ? value.verified === true && scope === 'LOCAL_FIXTURE'
      ? 'Verified fixture result'
      : value.verified === true && scope === 'PUBLIC_IMMUTABLE_READ'
        ? 'Verified intended read'
        : 'Result verification unavailable'
    : labels[state.success ? state.data : ''];
  const consistent =
    state.success &&
    digest !== null &&
    value.known === true &&
    typeof value.verified === 'boolean' &&
    value.canRetry === false &&
    value.label === expectedLabel &&
    (value.verified
      ? committed &&
        (scope === 'LOCAL_FIXTURE' || scope === 'PUBLIC_IMMUTABLE_READ')
      : scope === null);
  return {
    key: 'operation:' + id,
    id,
    state: consistent && state.success ? state.data : null,
    digest,
    label: consistent
      ? (value.label as string)
      : 'UNKNOWN — operation state / verification unavailable',
    verified: consistent ? (value.verified as boolean) : null,
    verificationScope: consistent ? (scope as string | null) : null,
    unavailable: !consistent,
    conflict: false,
  };
}
function mergeOperation(previous: Operation, next: Operation): Operation {
  if (previous.conflict || same(previous, next)) return previous;
  return {
    ...previous,
    state: null,
    digest: null,
    label: 'UNKNOWN — conflicting operation references',
    verified: null,
    verificationScope: null,
    unavailable: true,
    conflict: true,
  };
}
function task(item: Record<string, unknown>, id: string): Task {
  const f = record(item.fields) ? item.fields : {};
  const dependencies = Array.isArray(f.dependencies) ? f.dependencies : [];
  const deps = [...new Set(dependencies.filter(identifier))];
  const operations = new Map<string, Operation>();
  let operationsKnown = Array.isArray(f.operations);
  if (Array.isArray(f.operations)) {
    for (const value of f.operations) {
      if (!record(value) || !identifier(value.id)) {
        operationsKnown = false;
        continue;
      }
      const next = operation(value);
      const previous = operations.get(next.id);
      operations.set(next.id, previous ? mergeOperation(previous, next) : next);
    }
  }
  const coordination = {
    'Accountable VERA reference': identifier(f.accountableVERA)
      ? f.accountableVERA
      : unknown,
    'Original principal reference': identifier(f.originalPrincipal)
      ? f.originalPrincipal
      : unknown,
    'Project reference':
      f.project === null
        ? 'No project reference recorded'
        : identifier(f.project)
          ? f.project
          : unknown,
    'Waiting reason':
      f.waitingOn === null
        ? 'No waiting reason recorded'
        : text(f.waitingOn)
          ? f.waitingOn
          : unknown,
    'Coordination revision': integer(f.coordinationRevision)
      ? String(f.coordinationRevision)
      : unknown,
  };
  const title = text(item.title) ? item.title : 'Task label unavailable';
  const phase =
    typeof item.status === 'string' && phases.has(item.status)
      ? item.status
      : unknown;
  const revision = integer(item.version) ? String(item.version) : unknown;
  return {
    key: 'task:' + id,
    id,
    title,
    phase,
    revision,
    coordination,
    dependencies: deps,
    dependenciesKnown:
      Array.isArray(f.dependencies) &&
      Array.from(dependencies).every(identifier),
    operations: [...operations.values()],
    operationsKnown,
    factsKnown:
      text(item.title) &&
      phase !== unknown &&
      revision !== unknown &&
      Object.values(coordination).every((value) => value !== unknown),
    conflict: false,
  };
}
function conflictingTask(previous: Task): Task {
  return {
    ...previous,
    title: 'Task label unavailable',
    phase: unknown,
    revision: unknown,
    coordination: Object.fromEntries(
      Object.keys(previous.coordination).map((key) => [key, unknown]),
    ),
    dependencies: [],
    dependenciesKnown: false,
    operations: [],
    operationsKnown: false,
    factsKnown: false,
    conflict: true,
  };
}

/** Current-page references only. No traversal, scheduling or provider verification. */
export function deriveWorkMap(items: readonly ConsoleItem[]) {
  const tasks = new Map<string, Task>();
  const operations = new Map<string, Operation>();
  let incomplete = !Array.isArray(items);
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!record(item) || item.kind !== 'task' || !identifier(item.id)) {
        incomplete = true;
        continue;
      }
      const next = task(item, item.id);
      const previous = tasks.get(next.id);
      tasks.set(
        next.id,
        previous?.conflict
          ? previous
          : previous && !same(previous, next)
            ? conflictingTask(previous)
            : (previous ?? next),
      );
    }
  }
  for (const item of tasks.values()) {
    for (const next of item.operations) {
      const previous = operations.get(next.id);
      operations.set(next.id, previous ? mergeOperation(previous, next) : next);
    }
  }
  const result = [...tasks.values()].map((item) => {
    const refs = item.operations.map((op) => operations.get(op.id)!);
    const operationsKnown =
      item.operationsKnown && refs.every((op) => !op.unavailable);
    if (!item.factsKnown || !item.dependenciesKnown || !operationsKnown)
      incomplete = true;
    return { ...item, operations: refs, operationsKnown };
  });
  return { tasks: result, operations: [...operations.values()], incomplete };
}
function acceptedPage(envelope: Readonly<ReadEnvelope> | null) {
  const parsed = EnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return null;
  const page = parsed.data;
  if (
    !opaqueIdentity(page.session?.identity) ||
    !identifier(page.session?.tenant) ||
    !integer(page.projection_version) ||
    !(page.total === null || integer(page.total)) ||
    (page.total !== null && page.total < page.items.length) ||
    !text(page.source_revision) ||
    ![page.server_time, page.observed_at, page.fresh_until].every(
      (value) => text(value) && Number.isFinite(Date.parse(value)),
    )
  )
    return null;
  return page;
}

export function WorkMap({
  envelope,
  loading,
  stale,
  offline,
  readUnavailable,
  selectedTaskId,
  onInspectTask,
}: WorkMapProps) {
  const id = useId();
  const page = acceptedPage(envelope);
  const model = deriveWorkMap(page?.items ?? []);
  const byId = new Map(model.tasks.map((item) => [item.id, item]));
  const retained = loading || stale || offline || readUnavailable;
  const empty =
    page &&
    !retained &&
    !model.incomplete &&
    page.completeness === 'complete' &&
    page.cursor === null &&
    page.total === 0 &&
    page.items.length === 0;
  const notices = [
    loading && 'Loading authorized Work records.',
    readUnavailable && 'Work read unavailable; any shown records are retained.',
    stale && 'Stale snapshot; shown facts are not current.',
    offline && 'Offline; shown facts are from the last accepted snapshot.',
    page?.completeness === 'partial' &&
      'Partial snapshot; additional records or facts may be unavailable.',
    page?.cursor !== null &&
      page &&
      'Additional authorized pages exist; this map does not include them.',
    model.incomplete &&
      'Some records or relationship facts are UNKNOWN / unavailable.',
  ].filter(Boolean);
  return (
    <section aria-labelledby={`${id}-title`} aria-busy={loading}>
      <h2 id={`${id}-title`}>Work relationships</h2>
      <p className="muted">
        Loaded authorized Work page · read-only adjacency list. Task phases,
        operation outcomes and business goals remain separate.
      </p>
      {notices.length > 0 && <p role="status">{notices.join(' ')}</p>}
      {!page ? (
        <p role={loading ? 'status' : 'alert'}>
          {loading
            ? 'Waiting for an accepted tenant-scoped Work snapshot.'
            : 'Authorized Work snapshot unavailable or unsupported. No task facts adopted.'}
        </p>
      ) : (
        <>
          <p className="small muted wrap">
            {retained ? 'Retained page' : 'Accepted page'} · {page.scope} ·
            observed {page.observed_at} · projection {page.projection_version}
            {' · '}source {page.source_revision}
          </p>
          <p className="small muted">
            {model.tasks.length} loaded task records ·{' '}
            {page.total === null
              ? 'Collection count unknown'
              : `${page.total} records in the authorized filtered collection`}
          </p>
          <p>
            <a className="text-link" href="/console/evidence">
              Browse Evidence
            </a>
          </p>
          {!model.tasks.length && (
            <p>
              {empty
                ? 'No task records in this authorized view. This is not a readiness or success result.'
                : 'No usable task records on this loaded page. Missing work or outcomes are not inferred.'}
            </p>
          )}
          <ul className="records" aria-label="Loaded task relationships">
            {model.tasks.map((item) => (
              <li key={item.key}>
                <article className="record" aria-label={'Task ' + item.id}>
                  <div className="record-main">
                    <h3 className="record-title">
                      <button
                        type="button"
                        className="text-link"
                        aria-label={item.title + ' · Inspect task ' + item.id}
                        aria-current={
                          selectedTaskId === item.id ? 'true' : undefined
                        }
                        onClick={() => onInspectTask(item.id)}
                      >
                        {item.title}
                      </button>
                    </h3>
                    <p className="mono wrap">{item.id}</p>
                    <p className="wrap">Projected work phase: {item.phase}</p>
                    {item.conflict && (
                      <p className="small muted">
                        Conflicting task records; no record was chosen as
                        current.
                      </p>
                    )}
                    <dl className="facts">
                      {Object.entries({
                        'Task revision': item.revision,
                        ...item.coordination,
                      }).map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd className="wrap">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <h4>Depends on · recorded task references</h4>
                    <ul className="value-list">
                      {item.dependencies.map((target) => (
                        <li key={JSON.stringify([item.id, target])}>
                          <span className="mono wrap">{item.id}</span> depends
                          on{' '}
                          <button
                            type="button"
                            className="text-link mono wrap"
                            aria-label={'Inspect dependency task ' + target}
                            onClick={() => onInspectTask(target)}
                          >
                            {target}
                          </button>
                          {' · '}
                          {byId.has(target)
                            ? `Loaded record: ${byId.get(target)!.phase}`
                            : 'Referenced task not loaded; status UNKNOWN'}
                        </li>
                      ))}
                    </ul>
                    {!item.dependenciesKnown ? (
                      <p className="small muted">
                        Dependency metadata UNKNOWN / unavailable; shown
                        references may be incomplete.
                      </p>
                    ) : !item.dependencies.length ? (
                      <p className="small muted">
                        No dependency references recorded in this task
                        projection.
                      </p>
                    ) : null}
                    <h4>Linked operations · not workflow stages</h4>
                    <ul className="value-list">
                      {item.operations.map((op) => (
                        <li className="operation-link" key={op.key}>
                          <a
                            className="text-link mono wrap"
                            aria-label={'Inspect operation ' + op.id}
                            href={
                              '/console/evidence?selected=' +
                              encodeURIComponent('operation:' + op.id)
                            }
                          >
                            {op.id}
                          </a>
                          <p className="wrap">{op.label}</p>
                          <p className="small muted wrap">
                            Wire state: {op.state ?? unknown}.{' '}
                            {op.verified === true
                              ? `Server-reported verification scope: ${op.verificationScope}`
                              : op.verified === false
                                ? 'Verification not established.'
                                : 'Verification / scope unavailable.'}
                          </p>
                        </li>
                      ))}
                    </ul>
                    {!item.operationsKnown ? (
                      <p className="small muted">
                        Operation metadata UNKNOWN / unavailable; no missing
                        verification is inferred.
                      </p>
                    ) : !item.operations.length ? (
                      <p className="small muted">
                        No operation references recorded in this task
                        projection.
                      </p>
                    ) : null}
                  </div>
                </article>
              </li>
            ))}
          </ul>
          <p className="small muted">
            Profile and accountability records do not prove external effects or
            goal completion. Workflow stages and evidence-event associations are
            unavailable here. Opening an inspector requests authorized detail;
            this map never approves, dispatches, retries or resends.
          </p>
        </>
      )}
    </section>
  );
}
