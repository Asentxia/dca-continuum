'use client';
import React, { useId, useRef, useState } from 'react';
import {
  CommandInputs,
  Identifier,
  type ConsoleItem,
  type HumanCommand,
} from '@continuum/contracts';

export interface VeraProfileFormProps {
  mode: 'create' | 'edit';
  item?: ConsoleItem;
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<void>;
  onClose: () => void;
}

type Profile = Readonly<{
  id: string;
  name: string;
  description: string;
  revision: number;
  createdBy: string;
  epoch: unknown;
  generation: unknown;
}>;
type Draft = {
  mode: 'create' | 'edit';
  target: string;
  key: string;
  name: string;
  description: string;
  profile: Profile | null;
};
const omitted = new Set([
  '[Redacted]',
  '[Sensitive value omitted]',
  '[Depth limit]',
]);
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    Identifier.safeParse(value).success
  );
}
function loadedProfile(item?: ConsoleItem): Profile | null {
  if (
    !item ||
    item.kind !== 'vera' ||
    !identifier(item.id) ||
    !item.fields ||
    typeof item.fields !== 'object' ||
    Array.isArray(item.fields)
  )
    return null;
  const {
    profileName: name,
    description,
    profileRevision: revision,
    profileCreatedBy: createdBy,
  } = item.fields;
  if (
    item.fields.VERA !== item.id ||
    !identifier(createdBy) ||
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    omitted.has(name) ||
    omitted.has(description) ||
    !CommandInputs.update_vera_profile.safeParse({ name, description })
      .success ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > Number.MAX_SAFE_INTEGER - 1
  )
    return null;
  return {
    id: item.id,
    name,
    description,
    revision,
    createdBy,
    epoch: item.fields.principalEpoch,
    generation: item.fields.principalGeneration,
  };
}
function draftFor(mode: 'create' | 'edit', item?: ConsoleItem): Draft | null {
  const profile = mode === 'edit' ? loadedProfile(item) : null;
  if (mode === 'edit' && !profile) return null;
  return {
    mode,
    target: profile?.id ?? 'vera-' + crypto.randomUUID(),
    key: crypto.randomUUID(),
    name: profile ? profile.name : '',
    description: profile ? profile.description : '',
    profile,
  };
}
function counter(value: unknown) {
  if (typeof value === 'string' && !omitted.has(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return 'Unknown / not recorded';
}

export function VeraProfileForm({
  mode,
  item,
  canAct,
  busy,
  onCommand,
  onClose,
}: VeraProfileFormProps) {
  // One binding per mounted draft, never regenerated after a callback failure.
  const [draft, setDraft] = useState(() => draftFor(mode, item));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const bound = useRef(false);
  const id = useId();
  const current = mode === 'edit' ? loadedProfile(item) : null;
  const baseline = draft?.profile;
  const stale =
    !!draft &&
    (draft.mode !== mode ||
      (mode === 'edit' &&
        (!current ||
          !baseline ||
          current.id !== baseline.id ||
          current.revision !== baseline.revision ||
          current.name !== baseline.name ||
          current.description !== baseline.description ||
          current.createdBy !== baseline.createdBy)));
  const problem = !draft
    ? 'Profile unavailable. A complete current VERA profile is required; missing, legacy, partial or redacted records cannot be adopted. Close and reopen from a complete profile.'
    : stale
      ? 'The loaded profile changed or is unavailable. Your draft text has not been replaced. Close and reopen from the current complete profile.'
      : '';
  const nameValid = CommandInputs.create_vera.shape.name.safeParse(
    draft?.name,
  ).success;
  const descriptionValid =
    CommandInputs.create_vera.shape.description.safeParse(
      draft?.description,
    ).success;
  const blocked = !canAct || busy || pending || !!problem;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || blocked || sending.current || !nameValid || !descriptionValid)
      return;
    let revision = 0;
    if (draft.mode === 'edit') {
      if (!draft.profile) return;
      revision = draft.profile.revision;
    }
    sending.current = true;
    // A submitted idempotency key cannot silently acquire a different body.
    bound.current = true;
    setPending(true);
    setError('');
    try {
      await onCommand({
        schema_version: 1,
        idempotency_key: draft.key,
        kind: draft.mode === 'create' ? 'create_vera' : 'update_vera_profile',
        target: draft.target,
        expected_version: revision,
        input: { name: draft.name, description: draft.description },
      });
    } catch {
      setError(
        'The command result is unavailable here. No automatic resend occurred. Review its status before submitting again.',
      );
    } finally {
      sending.current = false;
      setPending(false);
    }
    // Outcome handling, durable lookup and global eligibility belong to parent.
    // Do not close, retry, reset the draft or infer success from this callback.
  }

  return (
    <form
      className="creation"
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-scope`}
      aria-busy={busy || pending}
    >
      <p className="eyebrow">HUMAN PROFILE COMMAND</p>
      <h2 id={`${id}-title`}>
        {mode === 'create' ? 'Record a VERA profile' : 'Edit VERA profile'}
      </h2>
      <p id={`${id}-scope`} className="muted">
        {mode === 'create'
          ? 'Creation records a VERA profile: PAUSED · requires setup. It does not configure services or start execution.'
          : 'Only name and description change. The stable VERA ID and creator are retained; principal counters are read-only, not the profile revision.'}{' '}
        Profile text is not a grant, approval, workflow admission or external
        execution result.
      </p>
      {draft && (
        <dl className="facts">
          <div>
            <dt>Stable VERA ID{mode === 'create' ? ' · draft' : ''}</dt>
            <dd className="mono wrap">{draft.target}</dd>
          </div>
          {baseline ? (
            <>
              <div>
                <dt>Creator · read only</dt>
                <dd className="mono wrap">{baseline.createdBy}</dd>
              </div>
              <div>
                <dt>Profile revision · loaded, read only</dt>
                <dd>{baseline.revision}</dd>
              </div>
              <div>
                <dt>Principal epoch · loaded, read only</dt>
                <dd>{counter(baseline.epoch)}</dd>
              </div>
              <div>
                <dt>Principal generation · loaded, read only</dt>
                <dd>{counter(baseline.generation)}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>Creator and counters</dt>
              <dd>Recorded by the server, not supplied by this form.</dd>
            </div>
          )}
        </dl>
      )}
      {draft && (
        <>
          <label>
            Name
            <textarea
              rows={2}
              value={draft.name}
              onChange={(event) => {
                if (!bound.current)
                  setDraft({ ...draft, name: event.target.value });
              }}
              readOnly={bound.current}
              required
              minLength={1}
              maxLength={200}
              disabled={blocked}
              aria-invalid={!nameValid}
              aria-describedby={`${id}-name-help`}
            />
          </label>
          <p className="small muted" id={`${id}-name-help`}>
            1–200 characters, not blank. Exact spelling and whitespace are kept.
          </p>
          <label>
            Description
            <textarea
              rows={5}
              value={draft.description}
              onChange={(event) => {
                if (!bound.current)
                  setDraft({ ...draft, description: event.target.value });
              }}
              readOnly={bound.current}
              maxLength={8000}
              disabled={blocked}
              aria-invalid={!descriptionValid}
              aria-describedby={`${id}-description-help`}
            />
          </label>
          <p className="small muted" id={`${id}-description-help`}>
            Optional, at most 8000 characters. Exact text is kept.
          </p>
        </>
      )}
      {problem && <p role="alert">{problem}</p>}
      {error && <p role="alert">{error}</p>}
      {bound.current && (
        <p className="small muted">
          Submitted draft text and its command binding are fixed. Review the
          command status before starting a different draft.
        </p>
      )}
      {!canAct && (
        <p className="small muted">
          Profile recording is unavailable for the current session.
        </p>
      )}
      {(busy || pending) && (
        <p role="status">
          Waiting for the command handler. No automatic resend.
        </p>
      )}
      <p className="small muted">
        Closing this form does not cancel a submitted command.
      </p>
      <div className="actions">
        <button type="button" onClick={() => onClose()}>
          Close form
        </button>
        <button
          className="primary"
          type="submit"
          disabled={blocked || !nameValid || !descriptionValid}
        >
          {mode === 'create' ? 'Record VERA profile' : 'Record profile changes'}
        </button>
      </div>
    </form>
  );
}
