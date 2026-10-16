import { PUBLIC_GITHUB_PROVIDER, PUBLIC_GITHUB_RESOURCE } from './contracts.js';
import { canonical } from '../db.js';
export const OPERATION_STATES = [
  'REQUESTED',
  'RESERVED',
  'SENDING',
  'COMMITTED',
  'UNKNOWN',
  'DENIED',
  'FAILED_KNOWN_NO_EFFECT',
] as const;
export const RAW_COMPUTER_STATES = [
  'requested',
  'provisioning',
  'ready',
  'running',
  'paused',
  'stopped',
  'waking',
  'checkpointing',
  'recovering',
  'restore_failed',
  'recovery_failed',
  'cleanup_needed',
  'error',
  'deleting',
  'deleted',
] as const;
export function operationTruth(o: Record<string, any>) {
  const known = OPERATION_STATES.includes(o.state),
    v = o.observation;
  const adapterKnown =
    o.provider === 'fixture'
      ? o.action === 'write' && o.resource === 'fixture-object'
      : o.provider === PUBLIC_GITHUB_PROVIDER &&
        o.action === 'readCommit' &&
        o.resource === PUBLIC_GITHUB_RESOURCE &&
        o.params?.owner === 'Adaptive-Liquidity' &&
        o.params?.repo === 'Continuum' &&
        o.params?.commit === '9ac4723b5390d22ed2d6aed9cf984cb0a32731ca' &&
        Object.keys(o.params).sort().join(',') === 'commit,owner,repo';
  let match = false;
  try {
    match = Boolean(
      adapterKnown &&
        v &&
        !Array.isArray(v) &&
        v.tenant === o.tenant &&
        v.operation === o.id &&
        v.digest === o.digest &&
        v.idempotency_key === o.idempotency_key &&
        canonical(v.payload) === canonical(o.params),
    );
  } catch {
    match = false;
  }
  const verified = Boolean(o.state === 'COMMITTED' && match);
  const labels: Record<string, string> = {
    REQUESTED: 'Pending',
    RESERVED: 'Preparing — reserved',
    SENDING: 'Executing — awaiting observation',
    COMMITTED: verified
      ? o.provider === PUBLIC_GITHUB_PROVIDER
        ? 'Verified intended read'
        : 'Verified fixture result'
      : 'Result verification unavailable',
    UNKNOWN: 'Outcome uncertain',
    DENIED: 'Denied',
    FAILED_KNOWN_NO_EFFECT: 'Failed — known no effect',
  };
  return {
    known,
    verified,
    label: known ? labels[o.state] : 'Update needed — unknown state',
    verificationScope: verified
      ? o.provider === 'fixture'
        ? 'LOCAL_FIXTURE'
        : 'PUBLIC_IMMUTABLE_READ'
      : null,
    canRetry: false,
  };
}
export function computerTruth(domain: string, raw?: string | null) {
  return {
    domain,
    raw: raw ?? 'unknown',
    knownRaw:
      raw === undefined || raw === null
        ? false
        : RAW_COMPUTER_STATES.includes(raw as any),
  };
}
export interface FocusCondition {
  id: string;
  root: string;
  cause: string;
  sourceVersion: number;
  tasks: string[];
  severity: number;
  title?: string;
  deadline?: string | null;
  observedAt?: string;
  related?: boolean;
}
export function groupFocus(items: FocusCondition[]) {
  const map = new Map<string, FocusCondition & { affectedCount: number }>();
  for (const item of items) {
    const key = item.related
        ? item.id
        : `${item.root}|${item.cause}|${item.sourceVersion}`,
      old = map.get(key);
    const tasks = [...new Set([...(old?.tasks ?? []), ...item.tasks])].sort();
    map.set(key, {
      ...old,
      ...item,
      tasks,
      affectedCount: tasks.length,
      severity: Math.min(old?.severity ?? 4, item.severity),
      observedAt:
        old && old.observedAt && item.observedAt
          ? old.observedAt < item.observedAt
            ? old.observedAt
            : item.observedAt
          : item.observedAt,
    });
  }
  return [...map.values()].sort(
    (a, b) =>
      a.severity - b.severity ||
      b.affectedCount - a.affectedCount ||
      date(a.deadline) - date(b.deadline) ||
      date(a.observedAt) - date(b.observedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
function date(v: string | null | undefined) {
  return v && Number.isFinite(Date.parse(v))
    ? Date.parse(v)
    : Number.MAX_SAFE_INTEGER;
}
export function workPhase(status: string, states: string[], verified: number) {
  if (status === 'CANCELLED')
    return 'Cancelled before later admission; in-flight effects may finish';
  if (states.includes('UNKNOWN')) return 'Outcome uncertain';
  if (states.some((x) => ['DENIED', 'FAILED_KNOWN_NO_EFFECT'].includes(x)))
    return 'Blocked';
  if (states.some((x) => ['SENDING', 'RESERVED'].includes(x)))
    return 'Executing';
  if (states.length > 0 && verified === states.length)
    return 'Effects verified — goal review required';
  if (states.includes('REQUESTED')) return 'Pending exact review';
  return 'Planned — no workflow admitted';
}
