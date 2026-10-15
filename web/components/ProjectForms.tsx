'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  CommandInputs,
  CommandSchema,
  Identifier,
  type ConsoleItem,
  type HumanCommand,
  type ReadEnvelope,
} from '@continuum/contracts';
import { read, type ClientEnvelope } from '@/lib/api';
import { freshLifetime } from '@/lib/client-state';
import { Facts } from './Primitives';

type CommandFormProps = {
  canAct: boolean;
  busy: boolean;
  onCommand: (value: HumanCommand) => Promise<void>;
  onClose?: () => void;
};

// The parent owns submission, durable lookup and all command outcome messages.
function useCommandHandoff({ canAct, busy, onCommand }: CommandFormProps) {
  const inFlight = useRef(false);
  const retained = useRef(false);
  const [pending, setPending] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [error, setError] = useState('');
  async function submit(makeCommand: () => HumanCommand) {
    if (!canAct || busy || inFlight.current || retained.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      await onCommand(CommandSchema.parse(makeCommand()));
    } catch {
      // A void callback provides no authoritative receipt. Retain every failed
      // handoff, including REQUEST_UNCONFIRMED; only the parent resolves it.
      retained.current = true;
      setFrozen(true);
      setError(
        'The console owns this request’s outcome. Check its command status before any further submission.',
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return {
    blocked: !canAct || busy || pending || frozen,
    pending,
    frozen,
    error,
    setError,
    submit,
  };
}

export function CreateProjectForm(props: CommandFormProps) {
  const { canAct, busy, onClose } = props;
  const handoff = useCommandHandoff(props);
  const formId = useId();
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const draft = useRef<HumanCommand | null>(null);
  const nameInvalid = !name.trim() || name.length > 200;
  const objectiveInvalid = objective.length > 8000;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (handoff.blocked) return;
    const body = CommandInputs.create_project.safeParse({ name, objective });
    if (!body.success || nameInvalid) {
      handoff.setError(
        'Use a non-blank project name of at most 200 characters and an objective of at most 8000 characters.',
      );
      return;
    }
    await handoff.submit(() => {
      if (
        !draft.current ||
        draft.current.input.name !== body.data.name ||
        draft.current.input.objective !== body.data.objective
      )
        draft.current = {
          schema_version: 1,
          idempotency_key: crypto.randomUUID(),
          kind: 'create_project',
          target: 'project-' + crypto.randomUUID(),
          expected_version: 0,
          input: body.data,
        };
      // CommandSchema in the handoff clones this binding before the callback.
      return draft.current;
    });
  }
  return (
    <form
      className="creation"
      aria-labelledby={formId + '-title'}
      aria-busy={busy || handoff.pending}
      onSubmit={submit}
    >
      <p className="eyebrow">BOUNDED HUMAN COMMAND</p>
      <h2 id={formId + '-title'}>Record a project</h2>
      <p className="muted" id={formId + '-help'}>
        This requests a project record only. It does not create work, an
        operation, a grant, an approval or a workflow, or send an external
        action. The console reports the durable command outcome.
      </p>
      {!canAct && (
        <p className="muted small" role="status">
          Command unavailable for the current session.
        </p>
      )}
      <label>
        Project name
        <input
          value={name}
          onChange={(event) => {
            if (handoff.blocked) return;
            setName(event.target.value);
            handoff.setError('');
          }}
          required
          maxLength={200}
          disabled={handoff.blocked}
          aria-invalid={Boolean(handoff.error) && Boolean(nameInvalid)}
          aria-describedby={
            formId + '-help' + (handoff.error ? ' ' + formId + '-error' : '')
          }
        />
      </label>
      <label>
        Project objective
        <textarea
          value={objective}
          onChange={(event) => {
            if (handoff.blocked) return;
            setObjective(event.target.value);
            handoff.setError('');
          }}
          maxLength={8000}
          disabled={handoff.blocked}
          aria-invalid={Boolean(handoff.error) && objectiveInvalid}
          aria-describedby={
            formId + '-help' + (handoff.error ? ' ' + formId + '-error' : '')
          }
        />
      </label>
      {handoff.error && (
        <p id={formId + '-error'} role="alert">
          {handoff.error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={handoff.blocked}>
          Submit project request
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            disabled={busy || handoff.pending || handoff.frozen}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

type ProjectScope = {
  work: ConsoleItem;
  canAct: boolean;
  revision: unknown;
  workAllowed: boolean | undefined;
  context?: Readonly<ClientEnvelope>;
  contextDeadline?: number;
};
type ProjectPage = ProjectScope & {
  query: string;
  status: 'idle' | 'loading' | 'error' | 'ready';
  projects: ConsoleItem[];
  pages: number;
  completeness: ReadEnvelope['completeness'] | null;
  cursor: ReadEnvelope['cursor'];
  total: ReadEnvelope['total'];
  snapshot: ClientEnvelope | null;
  deadline: number;
  commandsAllowed: boolean;
  error: string;
};
function emptyPage(
  scope: ProjectScope,
  query: string,
  status: ProjectPage['status'],
): ProjectPage {
  return {
    ...scope,
    query,
    status,
    projects: [],
    pages: 0,
    completeness: null,
    cursor: null,
    total: null,
    snapshot: null,
    deadline: 0,
    commandsAllowed: false,
    error: '',
  };
}
function sameScope(a: ProjectScope, b: ProjectScope) {
  return (
    a.work === b.work &&
    a.canAct === b.canAct &&
    Object.is(a.revision, b.revision) &&
    a.workAllowed === b.workAllowed &&
    a.context === b.context &&
    Object.is(a.contextDeadline, b.contextDeadline)
  );
}
function sameAccount(
  a: Readonly<ClientEnvelope> | undefined,
  b: Readonly<ClientEnvelope> | undefined,
) {
  return Boolean(
    a &&
      b &&
      a.scope === b.scope &&
      a.session?.identity === b.session?.identity &&
      a.session?.tenant === b.session?.tenant &&
      a.session?.principal === b.session?.principal,
  );
}
function sameSession(a: Readonly<ClientEnvelope>, b: Readonly<ClientEnvelope>) {
  return sameAccount(a, b) && a.csrf === b.csrf;
}
function contextLifetime(value: Readonly<ClientEnvelope> | undefined) {
  if (!value || typeof value !== 'object') return 0;
  const actor = value.session;
  const server =
    typeof value.server_time === 'string' ? Date.parse(value.server_time) : NaN;
  const lifetime =
    typeof value.fresh_until === 'string'
      ? freshLifetime(value.server_time, value.fresh_until)
      : NaN;
  if (
    !actor ||
    typeof actor.identity !== 'string' ||
    actor.identity.length === 0 ||
    // Preserve the existing command journal's opaque identity bound. Identity
    // is compared exactly, not normalized or interpreted as a browser tenant.
    actor.identity.length > 4096 ||
    typeof actor.tenant !== 'string' ||
    actor.tenant.length === 0 ||
    !(actor.principal === null || typeof actor.principal === 'string') ||
    actor.fresh_mfa !== true ||
    !Number.isFinite(server) ||
    !Number.isFinite(actor.expires) ||
    actor.expires <= server ||
    !Number.isFinite(lifetime) ||
    lifetime <= 0 ||
    value.features?.commands?.state !== 'available' ||
    (value.scope !== 'LOCAL_FIXTURE' && value.scope !== 'STAGING') ||
    typeof value.csrf !== 'string' ||
    value.csrf.length === 0 ||
    typeof value.source_revision !== 'string' ||
    value.source_revision.length === 0 ||
    !Number.isInteger(value.projection_version) ||
    value.projection_version < 0
  )
    return 0;
  return Math.min(lifetime, actor.expires - server);
}
function currentParent(scope: ProjectScope, now = performance.now()) {
  return (
    Number.isFinite(now) &&
    typeof scope.contextDeadline === 'number' &&
    Number.isFinite(scope.contextDeadline) &&
    scope.contextDeadline > now &&
    contextLifetime(scope.context) > 0
  );
}
function readError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return [
    'STALE_SNAPSHOT',
    'SESSION_EXPIRED',
    'SESSION_CHANGED',
    'READ_UNAVAILABLE',
    'UNKNOWN_SCHEMA',
  ].includes(code)
    ? code
    : 'READ_UNAVAILABLE';
}

// Only read() talks to the collection. Opaque cursors never become browser
// tenant parameters, and old pages cannot survive a changed query/work/scope.
function useProjectChoices(
  item: ConsoleItem,
  canAct: boolean,
  context?: Readonly<ClientEnvelope>,
  contextDeadline?: number,
) {
  const revision = item.fields.coordinationRevision;
  const workAllowed = item.eligibility?.allowed;
  const scope = useRef<ProjectScope>({
    work: item,
    canAct,
    revision,
    workAllowed,
    context,
    contextDeadline,
  });
  scope.current = {
    work: item,
    canAct,
    revision,
    workAllowed,
    context,
    contextDeadline,
  };
  const [query, setQuery] = useState('');
  const queryRef = useRef('');
  const [project, setProject] = useState('');
  const [sessionInvalid, setSessionInvalid] = useState(
    () => !currentParent(scope.current),
  );
  const projectRef = useRef('');
  const [page, setPage] = useState(() =>
    emptyPage(scope.current, '', 'loading'),
  );
  const pageRef = useRef(page);
  const mounted = useRef(false);
  const order = useRef(0);
  const request = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = useRef<ClientEnvelope | null>(null);
  const parent = useRef({ context, contextDeadline });
  const heldParent = useRef<Pick<
    ProjectScope,
    'context' | 'contextDeadline'
  > | null>(null);
  const usedCursors = useRef(new Set<string>());
  const contextCurrent = useCallback((value = scope.current) => {
    const held = heldParent.current;
    return (
      currentParent(value) &&
      sameAccount(parent.current.context, value.context) &&
      !(
        held &&
        held.context === value.context &&
        Object.is(held.contextDeadline, value.contextDeadline)
      )
    );
  }, []);
  const publish = useCallback((next: ProjectPage) => {
    pageRef.current = next;
    setPage(next);
  }, []);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const clearChoice = useCallback(() => {
    projectRef.current = '';
    setProject('');
  }, []);
  const invalidate = useCallback(
    (q: string, status: ProjectPage['status'] = 'idle', error = '') => {
      order.current++;
      request.current = null;
      clearTimer();
      clearChoice();
      usedCursors.current.clear();
      publish({ ...emptyPage(scope.current, q, status), error });
    },
    [clearTimer, clearChoice, publish],
  );
  const fail = useCallback(
    (code: string, requireParent = false) => {
      if (
        requireParent ||
        code === 'SESSION_EXPIRED' ||
        code === 'SESSION_CHANGED'
      )
        heldParent.current = {
          context: scope.current.context,
          contextDeadline: scope.current.contextDeadline,
        };
      setSessionInvalid(true);
      invalidate(queryRef.current, 'error', code);
    },
    [invalidate],
  );
  const load = useCallback(
    async (q: string, cursor?: string) => {
      if (!mounted.current || request.current !== null || q.length > 128)
        return;
      const previous = pageRef.current;
      const context = scope.current;
      const trusted = context.context;
      if (!trusted || !contextCurrent(context)) {
        fail(cursor ? 'STALE_SNAPSHOT' : 'SESSION_EXPIRED', true);
        return;
      }
      if (
        cursor &&
        (previous.status !== 'ready' ||
          !sameScope(previous, context) ||
          previous.query !== q ||
          previous.cursor !== cursor)
      )
        return; // Never broaden a refused cursor to a first-page request.
      if (
        cursor &&
        (performance.now() >= previous.deadline ||
          usedCursors.current.has(cursor))
      ) {
        fail('STALE_SNAPSHOT');
        return;
      }
      if (cursor) usedCursors.current.add(cursor);
      else usedCursors.current.clear();
      const ticket = ++order.current;
      const started = performance.now();
      const parentDeadline = Math.min(
        context.contextDeadline!,
        started + contextLifetime(trusted),
      );
      request.current = ticket;
      clearTimer();
      clearChoice();
      publish({
        ...emptyPage(context, q, 'loading'),
        projects: cursor ? previous.projects : [],
      });
      const current = () =>
        mounted.current &&
        order.current === ticket &&
        queryRef.current === q &&
        sameScope(context, scope.current);
      // A slow collection read cannot keep the initiating work context alive.
      timer.current = setTimeout(
        () => {
          if (current()) fail('STALE_SNAPSHOT', true);
        },
        Math.max(0, parentDeadline - performance.now()),
      );
      try {
        const params = { ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
        const next = Object.keys(params).length
          ? await read('projects', params)
          : await read('projects');
        if (!current()) return;
        if (!contextCurrent(context)) throw Error('SESSION_EXPIRED');
        if (
          contextLifetime(next) <= 0 ||
          !sameSession(trusted, next) ||
          trusted.source_revision !== next.source_revision
        )
          throw Error('SESSION_CHANGED');
        if (next.projection_version < trusted.projection_version)
          throw Error('STALE_SNAPSHOT');
        if (session.current && !sameSession(session.current, next))
          throw Error('SESSION_CHANGED');
        if (
          session.current &&
          next.projection_version < session.current.projection_version
        )
          throw Error('STALE_SNAPSHOT');
        if (
          cursor &&
          (!previous.snapshot ||
            previous.snapshot.projection_version !== next.projection_version ||
            previous.snapshot.source_revision !== next.source_revision ||
            (next.cursor && usedCursors.current.has(next.cursor)))
        )
          throw Error('STALE_SNAPSHOT');
        const lifetime = contextLifetime(next);
        const deadline = Math.min(
          parentDeadline,
          started + lifetime,
          cursor ? previous.deadline : Infinity,
        );
        if (!Number.isFinite(deadline) || deadline <= performance.now())
          throw Error('STALE_SNAPSHOT');
        const choices = new Map<string, ConsoleItem>();
        for (const choice of [
          ...(cursor ? previous.projects : []),
          ...next.items,
        ])
          if (
            choice.kind === 'project' &&
            Identifier.safeParse(choice.id).success
          )
            choices.set(choice.id, choice);
        session.current = next;
        setSessionInvalid(false);
        clearTimer();
        publish({
          ...emptyPage(context, q, 'ready'),
          projects: [...choices.values()],
          pages: cursor ? previous.pages + 1 : 1,
          completeness: next.completeness,
          cursor: next.cursor,
          total: next.total,
          snapshot: next,
          deadline,
          commandsAllowed:
            context.canAct &&
            context.workAllowed !== false &&
            next.session?.fresh_mfa === true &&
            next.features.commands?.state === 'available',
        });
        timer.current = setTimeout(
          () => {
            if (current()) fail('STALE_SNAPSHOT', !contextCurrent(context));
          },
          Math.max(0, deadline - performance.now()),
        );
      } catch (error) {
        if (current()) fail(readError(error));
      } finally {
        if (request.current === ticket) request.current = null;
      }
    },
    [clearTimer, clearChoice, publish, fail, contextCurrent],
  );
  useEffect(() => {
    mounted.current = true;
    if (
      parent.current.context !== context ||
      !Object.is(parent.current.contextDeadline, contextDeadline)
    ) {
      if (!sameAccount(parent.current.context, context)) {
        queryRef.current = '';
        setQuery('');
      }
      session.current = null;
      heldParent.current = null;
      setSessionInvalid(true); // Until a page confirms the new parent context.
    }
    parent.current = { context, contextDeadline };
    invalidate(queryRef.current, 'loading');
    void load(queryRef.current);
    return () => {
      mounted.current = false;
      order.current++;
      request.current = null;
      clearTimer();
    };
  }, [
    item,
    canAct,
    revision,
    workAllowed,
    context,
    contextDeadline,
    invalidate,
    load,
    clearTimer,
  ]);
  const currentPage =
    sameScope(page, scope.current) && page.query === query ? page : null;
  function editQuery(value: string) {
    if (value === queryRef.current) return;
    queryRef.current = value;
    setQuery(value);
    invalidate(value);
  }
  function search() {
    if (request.current !== null || queryRef.current.length > 128) return;
    invalidate(queryRef.current, 'loading');
    void load(queryRef.current);
  }
  function more() {
    const current = pageRef.current;
    if (current.status === 'ready' && current.cursor)
      void load(queryRef.current, current.cursor);
  }
  function choice() {
    const current = pageRef.current;
    if (!contextCurrent()) {
      fail('STALE_SNAPSHOT', true);
      return;
    }
    if (
      request.current !== null ||
      current.status !== 'ready' ||
      !sameScope(current, scope.current) ||
      current.query !== queryRef.current ||
      !current.commandsAllowed
    )
      return;
    if (performance.now() >= current.deadline) {
      fail('STALE_SNAPSHOT');
      return;
    }
    return current.projects.find((value) => value.id === projectRef.current);
  }
  function choose(value: string) {
    const current = pageRef.current;
    const allowed =
      current.status === 'ready' &&
      sameScope(current, scope.current) &&
      contextCurrent() &&
      current.commandsAllowed &&
      current.query === queryRef.current &&
      performance.now() < current.deadline;
    // Membership is checked against the read response, never DOM options.
    projectRef.current =
      allowed && current.projects.some((p) => p.id === value) ? value : '';
    setProject(projectRef.current);
  }
  return {
    query,
    project,
    sessionInvalid: sessionInvalid || !contextCurrent(),
    contextCurrent: contextCurrent(),
    page: currentPage,
    loading: !currentPage || currentPage.status === 'loading',
    editQuery,
    search,
    more,
    choose,
    choice,
  };
}

export function LinkTaskProjectForm({
  item,
  context,
  contextDeadline,
  ...props
}: CommandFormProps & {
  item: ConsoleItem;
  context?: Readonly<ClientEnvelope>;
  contextDeadline?: number;
}) {
  const { canAct, busy, onClose } = props;
  const handoff = useCommandHandoff(props);
  const formId = useId();
  const catalog = useProjectChoices(item, canAct, context, contextDeadline);
  const currentPage = catalog.page;
  const sessionInvalid = catalog.sessionInvalid;
  const ready =
    catalog.contextCurrent && currentPage?.status === 'ready'
      ? currentPage
      : null;
  const loading = catalog.contextCurrent && catalog.loading;
  const hasNextPage =
    ready && typeof ready.cursor === 'string' && ready.cursor.length > 0;
  const selected = ready?.projects.find(
    (choice) => choice.id === catalog.project,
  );
  const draft = useRef<HumanCommand | null>(null);
  const revision = item.fields.coordinationRevision;
  const validWork =
    item.kind === 'task' &&
    Identifier.safeParse(item.id).success &&
    typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    revision <= Number.MAX_SAFE_INTEGER - 1;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (handoff.blocked || !validWork) return;
    const selected = catalog.choice();
    if (!selected) return;
    const body = CommandInputs.link_task_project.safeParse({
      project: selected.id,
    });
    if (!body.success) return;
    await handoff.submit(() => {
      if (
        !draft.current ||
        draft.current.target !== item.id ||
        draft.current.expected_version !== revision ||
        draft.current.input.project !== body.data.project
      )
        draft.current = {
          schema_version: 1,
          idempotency_key: crypto.randomUUID(),
          kind: 'link_task_project',
          target: item.id,
          expected_version: revision as number,
          input: body.data,
        };
      return draft.current;
    });
  }
  return (
    <form
      className="creation"
      aria-labelledby={formId + '-title'}
      aria-busy={busy || handoff.pending || loading}
      onSubmit={submit}
    >
      <p className="eyebrow">BOUNDED HUMAN COMMAND</p>
      <h2 id={formId + '-title'}>Link existing work to a project</h2>
      <p className="muted" id={formId + '-help'}>
        This requests a project association only. It does not create work or an
        operation, change an approval or grant, transfer authority, start a
        workflow or send an external action. The console reports the command
        outcome.
      </p>
      {sessionInvalid ? (
        <p className="muted small" role="status">
          Private work snapshot hidden because the session could not be
          retained. Revalidate the session through the console.
        </p>
      ) : (
        <section aria-labelledby={formId + '-work'}>
          <h3 id={formId + '-work'}>Recorded work snapshot</h3>
          <p>{item.title}</p>
          <p className="muted small">
            Work ID: {item.id}. Task version: {item.version}. The fields below
            remain unchanged by this form.
          </p>
          <Facts item={item} />
        </section>
      )}
      {!canAct && (
        <p className="muted small" role="status">
          Command unavailable for the current session.
        </p>
      )}
      {!validWork && (
        <p role="status">
          An existing work task and an observed coordination revision that can
          be incremented safely are required. The task version is not a
          substitute.
        </p>
      )}
      <label>
        Search projects
        <input
          type="search"
          value={catalog.contextCurrent ? catalog.query : ''}
          maxLength={128}
          disabled={handoff.blocked || !catalog.contextCurrent}
          aria-invalid={catalog.query.length > 128}
          aria-describedby={formId + '-search-help'}
          onChange={(event) => {
            if (!handoff.blocked && catalog.contextCurrent)
              catalog.editQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            if (!handoff.blocked && catalog.contextCurrent) catalog.search();
          }}
        />
      </label>
      <p className="muted small" id={formId + '-search-help'}>
        Up to 128 characters. Search reads the authorized server collection, not
        just the rows already loaded. Changing the query clears choices and its
        cursor; submit Search projects to read the new query.
      </p>
      {catalog.query.length > 128 && (
        <p role="alert">Use a project query of at most 128 characters.</p>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={
            handoff.blocked ||
            !catalog.contextCurrent ||
            loading ||
            catalog.query.length > 128
          }
          onClick={() => {
            if (!handoff.blocked && catalog.contextCurrent) catalog.search();
          }}
        >
          Search projects
        </button>
      </div>
      <label>
        Project from server results
        <select
          value={catalog.project}
          required
          disabled={handoff.blocked || !ready?.commandsAllowed || !validWork}
          aria-describedby={formId + '-page ' + formId + '-help'}
          onChange={(event) => {
            if (handoff.blocked || !validWork) return;
            catalog.choose(event.target.value);
            handoff.setError('');
          }}
        >
          <option value="">Choose a listed project</option>
          {catalog.contextCurrent &&
            currentPage?.projects.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.title} · {choice.id}
              </option>
            ))}
        </select>
      </label>
      <div id={formId + '-page'} aria-live="polite">
        {loading && <p role="status">Loading server-scoped project choices…</p>}
        {currentPage?.status === 'idle' && (
          <p role="status">
            Previous choices and cursor cleared. Search projects to load this
            query.
          </p>
        )}
        {currentPage?.status === 'error' && (
          <p role="alert">
            Project choices could not be read. No selection is available.{' '}
            {currentPage.error}. Refresh project choices explicitly; no cursor
            fallback or command resubmission is performed.
            {currentPage.error === 'SESSION_EXPIRED' &&
              ' Sign in and revalidate eligibility through the console first.'}
            {currentPage.error === 'SESSION_CHANGED' &&
              ' The project read did not retain the verified work context; revalidate eligibility through the console first.'}
          </p>
        )}
        {ready && (
          <>
            <p className="muted small">
              {ready.pages === 1
                ? `${ready.projects.length} project choices on this server-scoped first page.`
                : `${ready.projects.length} unique project choices loaded across ${ready.pages} server-scoped pages.`}{' '}
              Only listed projects can be selected here.
            </p>
            <p className="muted small">
              Applied query: {ready.query || 'No search filter'}. Latest server
              completeness: {ready.completeness}.
            </p>
            <p className="muted small">
              {ready.total === null
                ? 'Server-reported total unavailable. It is not inferred from loaded choices.'
                : `Latest server response reports total: ${ready.total}. It is not inferred from loaded choices.`}
            </p>
            {!ready.projects.length && <p>No projects on this page.</p>}
            {(ready.completeness === 'partial' || hasNextPage) && (
              <p className="muted small">
                Partial project registry; this is not a complete list.
              </p>
            )}
            {hasNextPage && (
              <p className="muted small">
                A next page is available but is not loaded yet. Load more
                project choices explicitly.
              </p>
            )}
            {!hasNextPage && (
              <p className="muted small">
                No next-page cursor was returned for this query. No
                complete-registry claim is inferred from the loaded count.
              </p>
            )}
            {!ready.commandsAllowed && (
              <p role="status">
                The current server read does not allow commands. Revalidate
                eligibility through the console before choosing a project.
              </p>
            )}
          </>
        )}
      </div>
      {handoff.error && <p role="alert">{handoff.error}</p>}
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={
            handoff.blocked ||
            !validWork ||
            !selected ||
            !ready?.commandsAllowed ||
            performance.now() >= ready.deadline
          }
        >
          Submit project link request
        </button>
        {hasNextPage && (
          <button
            type="button"
            disabled={handoff.blocked || loading}
            onClick={() => {
              if (!handoff.blocked) catalog.more();
            }}
          >
            Load more project choices
          </button>
        )}
        <button
          type="button"
          disabled={
            handoff.blocked ||
            !catalog.contextCurrent ||
            loading ||
            catalog.query.length > 128
          }
          onClick={() => {
            if (!handoff.blocked && catalog.contextCurrent) catalog.search();
          }}
        >
          Refresh project choices
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            disabled={busy || handoff.pending || handoff.frozen}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
