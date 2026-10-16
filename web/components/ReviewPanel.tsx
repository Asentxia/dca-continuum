'use client';
import React from 'react';
import { useState, useCallback } from 'react';
import Link from 'next/link';
import type { ConsoleItem, HumanCommand } from '@continuum/contracts';
import { Facts, Value, Badge, Confirm } from './Primitives';
import { AssignmentForm } from './AssignmentForm';
export function ReviewPanel({
  item,
  canAct,
  busy,
  onCommand,
  onRefresh,
}: {
  item: ConsoleItem;
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<void>;
  onRefresh: () => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [copy, setCopy] = useState('');
  const close = useCallback(() => setConfirm(false), []);
  const f = item.fields;
  const isProposal = item.kind === 'operation' && f.effectState === 'REQUESTED';
  const make = (
    kind: HumanCommand['kind'],
    input: Record<string, unknown> = {},
  ) => ({
    schema_version: 1 as const,
    idempotency_key: crypto.randomUUID(),
    kind,
    target: item.id,
    expected_version: item.version,
    input,
  });
  async function approve() {
    await onCommand(
      make('approve', {
        digest: f.digest,
        expires: f.maximumApprovalExpiry,
        approvalRevision: f.approvalRevision,
      }),
    );
  }
  return (
    <>
      <div className="inspector-heading">
        <p className="eyebrow">
          {item.kind === 'operation'
            ? 'EXACT ACTION REVIEW'
            : 'DURABLE OBJECT DETAIL'}
        </p>
        <h2>{item.title}</h2>
        <Badge value={item.status} />
        <p className="object-id mono">{item.id}</p>
      </div>
      {isProposal ? (
        <>
          <div className="decision-note">
            Approval records permission for this exact action. It does not
            execute it or prove success.
          </div>
          {f.contextQuarantined === true ? (
            <div className="decision-note">
              Quarantined context is not an admitted fact and is not effect
              authority.
            </div>
          ) : null}
          <dl className="facts">
            {[
              'principal',
              'provider',
              'action',
              'resource',
              'reason',
              'grant',
              'grantVersion',
              'principalEpoch',
              'principalGeneration',
              'computerId',
              'placementGeneration',
              'contextId',
              'contextVersion',
              'cognitionRevision',
              'deadline',
              'costCeiling',
              'unit',
              'verificationMethod',
              'approvalStatus',
              'approvalExpires',
              'maximumApprovalExpiry',
            ].map((k) => (
              <div key={k}>
                <dt>{k.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
                <dd>
                  <Value value={f[k]} />
                </dd>
              </div>
            ))}
          </dl>
          <h3>Exact parameters · read-only</h3>
          <pre
            className="payload"
            tabIndex={0}
            aria-label="Complete exact parameters"
          >
            {JSON.stringify(f.parameters, null, 2)}
          </pre>
          <div className="actions">
            <button
              className="primary"
              disabled={!canAct || busy || !item.eligibility?.allowed}
              onClick={approve}
            >
              Approve exact action
            </button>
            <button disabled={busy} onClick={onRefresh}>
              Refresh exact review
            </button>
          </div>
          <p className="muted small">
            {item.eligibility?.reason} No automatic retry after an unconfirmed
            request.
          </p>
          <AssignmentForm
            item={item}
            canAct={canAct}
            busy={busy}
            onCommand={onCommand}
          />
          <details className="technical">
            <summary>Technical binding and evidence</summary>
            <p className="mono wrap">SHA-256 {String(f.digest)}</p>
            <pre className="payload" tabIndex={0}>
              {JSON.stringify(f.canonicalBinding, null, 2)}
            </pre>
            <Facts
              item={item}
              omit={[
                'canonicalBinding',
                'parameters',
                ...(item.kind === 'project' ? ['tasks'] : []),
              ]}
            />
            {item.kind === 'project' && Array.isArray(f.tasks) && (
              <div>
                <h3>Scoped project work</h3>
                {(f.tasks as string[]).map((id) => (
                  <p key={id}>
                    <Link
                      className="text-link"
                      href={
                        '/console/work?selected=' +
                        encodeURIComponent('task:' + id)
                      }
                    >
                      {id}
                    </Link>
                  </p>
                ))}
              </div>
            )}
          </details>
        </>
      ) : item.kind === 'task' ? (
        <>
          <Facts item={item} omit={['operations']} />
          <h3>Operations · separate from task progress</h3>
          {Array.isArray(f.operations) && f.operations.length ? (
            (f.operations as any[]).map((o) => (
              <div className="operation-link" key={o.id}>
                <Link
                  href={
                    '/console/' +
                    (o.state === 'UNKNOWN'
                      ? 'recovery'
                      : o.state === 'REQUESTED'
                        ? 'approvals'
                        : 'evidence') +
                    '?selected=' +
                    encodeURIComponent(
                      !['UNKNOWN', 'REQUESTED'].includes(o.state)
                        ? 'operation:' + o.id
                        : o.id,
                    )
                  }
                >
                  {o.id}
                </Link>
                <Badge value={o.label} />
                <p className="muted small">
                  Wire state: {o.state}. Verified scope:{' '}
                  {o.verificationScope ?? 'none'}.
                </p>
              </div>
            ))
          ) : (
            <p className="muted">
              No operations recorded. Task creation did not admit execution.
            </p>
          )}
        </>
      ) : (
        <>
          {item.kind === 'operation' && f.contextQuarantined === true ? (
            <p className="muted">
              Quarantined context is not an admitted fact and is not effect
              authority.
            </p>
          ) : null}
          <Facts
            item={item}
            omit={[
              'canonicalBinding',
              'parameters',
              ...(item.kind === 'project' ? ['tasks'] : []),
            ]}
          />
          {item.kind === 'project' && Array.isArray(f.tasks) && (
            <div>
              <h3>Scoped project work</h3>
              {(f.tasks as string[]).map((id) => (
                <p key={id}>
                  <Link
                    className="text-link"
                    href={
                      '/console/work?selected=' +
                      encodeURIComponent('task:' + id)
                    }
                  >
                    {id}
                  </Link>
                </p>
              ))}
            </div>
          )}
          {item.kind === 'operation' && (
            <details>
              <summary>Complete recorded binding</summary>
              <pre className="payload" tabIndex={0}>
                {JSON.stringify(f.canonicalBinding, null, 2)}
              </pre>
            </details>
          )}
          {item.kind === 'grant' && f.revoked === false && (
            <div className="actions">
              <button
                id="revoke-button"
                className="danger"
                disabled={!canAct || busy}
                onClick={() => setConfirm(true)}
              >
                Revoke grant
              </button>
            </div>
          )}
          {item.kind === 'incident' && item.status === 'OPEN' && (
            <button
              disabled={!canAct || busy}
              onClick={() => onCommand(make('ack_incident'))}
            >
              Acknowledge incident
            </button>
          )}
          {item.kind === 'notification' && !f.readAt && (
            <button
              disabled={!canAct || busy}
              onClick={() => onCommand(make('mark_notification_read'))}
            >
              Mark notification read
            </button>
          )}
          {item.kind === 'computer' && (
            <div className="notice">
              Managed viewing, input and lifecycle controls are unavailable
              until isolation is qualified. Hand-back never implies agent
              resume.
            </div>
          )}
        </>
      )}
      <div className="detail-footer">
        <button
          className="quiet"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(item.id);
              setCopy('ID copied');
            } catch {
              setCopy('Select the ID above to copy it.');
            }
          }}
        >
          Copy object ID
        </button>
        <span role="status" className="small">
          {copy}
        </span>
      </div>
      {confirm && (
        <Confirm
          title="Revoke this exact grant?"
          onCancel={close}
          busy={busy}
          onConfirm={async () => {
            await onCommand(make('revoke_grant'));
            setConfirm(false);
          }}
        />
      )}
    </>
  );
}
