'use client';
import React from 'react';
import { useEffect, useRef } from 'react';
import type { ConsoleItem } from '@continuum/contracts';
export function Badge({ value }: { value: string }) {
  const kind =
    /uncertain|unconfirmed|pending|quarant|expired|reconcil|blocked/i.test(
      value,
    )
      ? 'attention'
      : /denied|failed|LOST|error|revoked/i.test(value)
        ? 'critical'
        : /verified/i.test(value)
          ? 'verified'
          : 'neutral';
  return (
    <span className={'badge ' + kind}>
      <span aria-hidden className="status-dot" />
      {value}
    </span>
  );
}
export function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="muted">Unknown / not recorded</span>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (Array.isArray(value))
    return value.length ? (
      <ul className="value-list">
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} />
          </li>
        ))}
      </ul>
    ) : (
      <span className="muted">None recorded</span>
    );
  if (typeof value === 'object')
    return (
      <dl className="nested-facts">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}>
            <dt>{label(k)}</dt>
            <dd>
              <Value value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span className={/^[a-f0-9]{40,}$/.test(String(value)) ? 'mono wrap' : ''}>
      {String(value)}
    </span>
  );
}
export function label(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
export function Facts({
  item,
  omit = [],
}: {
  item: ConsoleItem;
  omit?: string[];
}) {
  return (
    <dl className="facts">
      {Object.entries(item.fields)
        .filter(([k]) => !omit.includes(k))
        .map(([k, v]) => (
          <div key={k}>
            <dt>{label(k)}</dt>
            <dd>
              <Value value={v} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function Confirm({
  title,
  onCancel,
  onConfirm,
  busy,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    back.current = document.activeElement as HTMLElement;
    const node = ref.current;
    node?.querySelector<HTMLButtonElement>('button')?.focus();
    function keys(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Tab' && node) {
        const nodes = [
          ...node.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input:not(:disabled)',
          ),
        ];
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    node?.addEventListener('keydown', keys);
    return () => {
      node?.removeEventListener('keydown', keys);
      back.current?.focus();
    };
  }, [onCancel]);
  return (
    <div className="modal-backdrop">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        ref={ref}
      >
        <p className="eyebrow">EXPLICIT AUTHORITY CHANGE</p>
        <h2 id="confirm-title">{title}</h2>
        <p>
          New admissions will be blocked. Already-admitted or in-flight effects
          may still finish. This does not resolve UNKNOWN outcomes.
        </p>
        <div className="actions">
          <button onClick={onCancel}>Keep grant</button>
          <button className="danger" disabled={busy} onClick={onConfirm}>
            Confirm revocation
          </button>
        </div>
      </div>
    </div>
  );
}
