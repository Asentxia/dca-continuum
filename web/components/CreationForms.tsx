'use client';
import React from 'react';
import { useState, useEffect } from 'react';
import {
  PUBLIC_GITHUB_RESOURCE,
  type HumanCommand,
  type ConsoleItem,
} from '@continuum/contracts';
import { read } from '@/lib/api';
function mandateChoices(items: ConsoleItem[], organization: string) {
  const org = items.find((item) => item.id === organization);
  const raw = org?.fields.mandates;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as { id?: unknown; version?: unknown; title?: unknown };
    const version = Number(row.version);
    if (
      typeof row.id !== 'string' ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      return [];
    return [
      {
        id: row.id,
        version,
        title: typeof row.title === 'string' ? row.title : row.id,
      },
    ];
  });
}
function firstBinding(items: ConsoleItem[]) {
  for (const item of items) {
    const choice = mandateChoices(items, item.id)[0];
    if (choice) return { organization: item.id, mandate: choice.id };
  }
  return null;
}
export function CreationForm({
  kind,
  canAct,
  busy,
  onCommand,
  onClose,
  serverTime,
}: {
  kind: 'task' | 'grant';
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<void>;
  onClose: () => void;
  serverTime: string;
}) {
  const [agents, setAgents] = useState<ConsoleItem[]>([]),
    [governance, setGovernance] = useState<ConsoleItem[]>([]),
    [principal, setPrincipal] = useState(''),
    [organization, setOrganization] = useState(''),
    [mandate, setMandate] = useState(''),
    [objective, setObjective] = useState(''),
    [action, setAction] = useState<'write' | 'readCommit'>('write');
  const [expiry, setExpiry] = useState(
      new Date(Date.parse(serverTime) + 3600000).toISOString().slice(0, 16),
    ),
    [max, setMax] = useState(1),
    [budget, setBudget] = useState(5),
    [error, setError] = useState('');
  const choices = mandateChoices(governance, organization);
  const selected = choices.find((choice) => choice.id === mandate);
  useEffect(() => {
    read('agents')
      .then((r) => {
        setAgents(r.items);
        setPrincipal(
          r.items.find(
            (i) =>
              Array.isArray(i.fields.workloadIdentities) &&
              (i.fields.workloadIdentities as any[]).length,
          )?.id ??
            r.items[0]?.id ??
            '',
        );
      })
      .catch(() => setError('Agent registry unavailable.'));
  }, []);
  useEffect(() => {
    if (kind !== 'task') return;
    read('governance')
      .then((r) => {
        setGovernance(r.items);
        const binding = firstBinding(r.items);
        if (!binding) return;
        setOrganization(binding.organization);
        setMandate(binding.mandate);
      })
      .catch(() => setError('Governance registry unavailable.'));
  }, [kind]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canAct || busy) return;
    const time = new Date(expiry + 'Z').toISOString(),
      id = (kind === 'task' ? 'task-' : 'grant-') + crypto.randomUUID();
    if (kind === 'task' && !selected) return;
    await onCommand({
      schema_version: 1,
      idempotency_key: crypto.randomUUID(),
      kind: kind === 'task' ? 'create_task' : 'create_grant',
      target: id,
      expected_version: 0,
      input:
        kind === 'task'
          ? {
              principal,
              objective,
              deadline: time,
              organization,
              mandate: selected!.id,
              mandateVersion: selected!.version,
            }
          : {
              principal,
              action,
              resource:
                action === 'write' ? 'fixture-object' : PUBLIC_GITHUB_RESOURCE,
              expires: time,
              maxCost: max,
              budget,
            },
    });
  }
  return (
    <form onSubmit={submit} className="creation">
      <p className="eyebrow">BOUNDED HUMAN COMMAND</p>
      <h2>
        {kind === 'task' ? 'Record a task' : 'Create an exact bounded grant'}
      </h2>
      <p className="muted">
        {kind === 'task'
          ? 'This records work only. No operation, workflow or external action is started. A mandate does not authorize an effect.'
          : 'A grant does not assign a worker, approve a proposal or dispatch an effect.'}
      </p>
      <label>
        Accountable VERA
        <select
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
          required
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
      {kind === 'task' ? (
        <>
          <label>
            Organization
            <select
              value={organization}
              onChange={(e) => {
                const next = e.target.value;
                setOrganization(next);
                setMandate(mandateChoices(governance, next)[0]?.id ?? '');
              }}
              required
            >
              {governance.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Current mandate
            <select
              value={mandate}
              onChange={(e) => setMandate(e.target.value)}
              required
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Work objective
            <textarea
              rows={5}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              maxLength={8000}
              required
            />
          </label>
        </>
      ) : (
        <>
          <label>
            Supported action
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as any)}
            >
              <option value="write">Local fixture write · test only</option>
              <option value="readCommit">Pinned public GitHub read</option>
            </select>
          </label>
          <p>
            Exact resource:{' '}
            <span className="mono wrap">
              {action === 'write' ? 'fixture-object' : PUBLIC_GITHUB_RESOURCE}
            </span>
          </p>
          <label>
            Maximum action cost · test units
            <input
              type="number"
              min={0}
              max={1000000}
              value={max}
              onChange={(e) => setMax(Number(e.target.value))}
              required
            />
          </label>
          <label>
            Total bound · test units
            <input
              type="number"
              min={max}
              max={1000000}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              required
            />
          </label>
        </>
      )}
      <label>
        {kind === 'task' ? 'Task deadline' : 'Grant expiry'} · UTC
        <input
          type="datetime-local"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          required
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel unsent form
        </button>
        <button
          className="primary"
          type="submit"
          disabled={
            !canAct || busy || !principal || (kind === 'task' && !selected)
          }
        >
          {kind === 'task' ? 'Record task' : 'Create bounded grant'}
        </button>
      </div>
    </form>
  );
}
