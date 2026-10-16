'use client';
import React, { useEffect, useState } from 'react';
import type { ConsoleItem, HumanCommand } from '@continuum/contracts';
import { read } from '@/lib/api';
export function AssignmentForm({
  item,
  canAct,
  busy,
  onCommand,
}: {
  item: ConsoleItem;
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<void>;
}) {
  const [machines, setMachines] = useState<ConsoleItem[]>([]),
    [machine, setMachine] = useState(''),
    [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setMachines([]);
    setMachine('');
    read('security')
      .then((r) => {
        if (!current) return;
        const values = r.items.filter(
          (i) =>
            i.fields.kind === 'machine' &&
            i.fields.active === true &&
            i.fields.VERA === item.fields.principal,
        );
        setMachines(values);
        setMachine(values[0]?.id ?? '');
      })
      .catch(() => {
        if (!current) return;
        setMachines([]);
        setMachine('');
      });
    return () => {
      current = false;
    };
  }, [open, item.id, item.fields.principal]);
  const existing = Array.isArray(item.fields.workloadAssignments)
    ? (item.fields.workloadAssignments as any[])
    : [];
  return (
    <section className="assignment">
      <h3>Independent workload assignment</h3>
      {existing.length ? (
        <p className="muted small">
          Recorded machine binding: {existing.map((x) => x.identity).join(', ')}
          . Assignment is not approval or issuance.
        </p>
      ) : (
        <>
          <button
            type="button"
            disabled={!canAct || busy}
            onClick={() => setOpen(!open)}
          >
            Review machine assignment
          </button>
          {open && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!canAct || !machine) return;
                await onCommand({
                  schema_version: 1,
                  idempotency_key: crypto.randomUUID(),
                  kind: 'assign',
                  target: item.id,
                  expected_version: item.version,
                  input: { identity: machine, expires: item.fields.deadline },
                });
              }}
            >
              <p className="small">
                One enrolled machine, bound to the immutable operation digest
                above. No VERA or grant scope is widened.
              </p>
              <label>
                Machine identity
                <select
                  value={machine}
                  onChange={(e) => setMachine(e.target.value)}
                  required
                >
                  {machines.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id} · version {String(i.fields.version)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="small">
                Bounded assignment expiry: {String(item.fields.deadline)}
              </p>
              <button
                className="primary"
                disabled={!canAct || busy || !machine}
                type="submit"
              >
                Record exact assignment
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
