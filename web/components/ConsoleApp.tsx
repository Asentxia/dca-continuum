'use client';
import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import type {
  ConsoleItem,
  HumanCommand,
  ReadEnvelope,
} from '@continuum/contracts';
import { read, command, lookupCommand, type ClientEnvelope } from '@/lib/api';
import {
  restoreCommandJournal,
  rememberCommand,
  clearCommandJournal,
  validJournalIdentity,
  type PendingCommand,
} from '@/lib/command-journal';
import {
  ResponseOrder,
  freshLifetime,
  canMutate,
  stableOrder,
  changedRows,
} from '@/lib/client-state';
import { Badge } from './Primitives';
import { ReviewPanel } from './ReviewPanel';
import { CreationForm } from './CreationForms';
import { CreateProjectForm, LinkTaskProjectForm } from './ProjectForms';
import { VeraProfileForm } from './VeraProfileForm';
import { WorkMap } from './WorkMap';

function acceptedSessionKey(envelope: ClientEnvelope): string | null {
  const actor = envelope.session;
  const serverTime = Date.parse(envelope.server_time);
  if (
    !actor ||
    !validJournalIdentity(actor.identity) ||
    !validJournalIdentity(actor.tenant) ||
    (actor.principal !== null && !validJournalIdentity(actor.principal)) ||
    !Number.isFinite(serverTime) ||
    !Number.isFinite(actor.expires) ||
    actor.expires <= serverTime ||
    !validJournalIdentity(envelope.csrf)
  )
    return null;
  return JSON.stringify([
    actor.identity,
    actor.tenant,
    actor.principal,
    envelope.scope,
    envelope.csrf,
    envelope.source_revision,
  ]);
}
const navGroups = [
  {
    label: 'Core work',
    items: [
      ['work', 'Work'],
      ['projects', 'Projects'],
      ['agents', 'Agents / VERA'],
      ['approvals', 'Approvals'],
      ['evidence', 'Evidence'],
      ['recovery', 'Recovery'],
    ],
  },
  {
    label: 'Governance',
    items: [
      ['governance', 'Governance'],
      ['authority', 'Authority'],
      ['security', 'Security'],
    ],
  },
  {
    label: 'Workspace',
    items: [
      ['computers', 'Computers'],
      ['context', 'State / Context'],
      ['integrations', 'Integrations'],
      ['incidents', 'Incidents'],
      ['notifications', 'Notifications'],
      ['usage', 'Usage / Limits'],
      ['settings', 'Settings'],
      ['setup', 'Onboarding / Setup'],
    ],
  },
];
const titles = Object.fromEntries(navGroups.flatMap((group) => group.items)),
  descriptions: Record<string, string> = {
    work: 'Decisions, blockers and results—grounded in durable state.',
    approvals:
      'Review exact actions. Permission, execution and verification stay separate.',
    recovery:
      'Keep uncertainty visible. Observe before deciding; never resend blindly.',
    agents:
      'Persistent accountable principals, independent of models and computers.',
    projects:
      'Organize durable work without changing its approval or authority.',
    computers:
      'Logical environments, observed placement and explicit recovery obligations.',
    governance:
      'Mandates, roles and membership. None of these authorize an effect.',
    context: 'Attributable context is data, never permission.',
    evidence:
      'Inspect provenance and integrity without mistaking logs for provider truth.',
  };
type AppearancePreference = 'system' | 'light' | 'dark';
type CommandOutcome =
  | 'APPLIED'
  | 'DENIED'
  | 'UNCONFIRMED'
  | 'UNAVAILABLE'
  | 'SESSION_EXPIRED';
const appearanceStorageKey = 'continuum.console.appearance';
function isAppearance(value: string | null): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}
export function ConsoleApp({
  section,
  mode,
}: {
  section: string;
  mode: 'LOCAL_FIXTURE' | 'STAGING';
}) {
  const router = useRouter(),
    params = useSearchParams(),
    selected = params.get('selected') ?? '',
    query = params.get('q') ?? '';
  const [appearance, setAppearance] = useState<AppearancePreference>('system');
  const [view, setView] = useState<'focus' | 'work'>('focus'),
    [workPresentation, setWorkPresentation] = useState<'list' | 'map'>('list'),
    [draftQ, setDraftQ] = useState(query),
    [data, setData] = useState<ClientEnvelope | null>(null),
    [rows, setRows] = useState<ConsoleItem[]>([]),
    [detail, setDetail] = useState<{
      item: ConsoleItem;
      envelope: ClientEnvelope;
      at: number;
      ttl: number;
    } | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(true),
    [stale, setStale] = useState(false),
    [newCount, setNewCount] = useState(0),
    [creating, setCreating] = useState<
      | 'task'
      | 'grant'
      | 'project'
      | 'vera'
      | 'edit_vera'
      | 'link_project'
      | null
    >(null),
    [unconfirmed, setUnconfirmed] = useState<PendingCommand | null>(null),
    [loading, setLoading] = useState(true),
    [reading, setReading] = useState(true),
    [readUnavailable, setReadUnavailable] = useState(false);
  const order = useRef(new ResponseOrder()),
    detailOrder = useRef(0),
    sessionId = useRef(''),
    sessionKey = useRef<string | null>(null),
    sessionEpoch = useRef(0),
    viewActive = useRef(false),
    viewGeneration = useRef(0),
    acceptedRead = useRef<{ resource: string; query: string } | null>(null),
    received = useRef(0),
    ttl = useRef(0),
    frozen = useRef(false),
    pending = useRef<ConsoleItem[]>([]),
    rowsRef = useRef<ConsoleItem[]>([]),
    identityInvalid = useRef(false),
    pendingCommand = useRef<PendingCommand | null>(null),
    submitting = useRef(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(appearanceStorageKey);
      if (isAppearance(stored)) setAppearance(stored);
    } catch {
      // Unavailable browser storage leaves the system preference in control.
    }
  }, []);
  function changeAppearance(value: string) {
    if (!isAppearance(value)) return;
    setAppearance(value);
    try {
      if (value === 'system') localStorage.removeItem(appearanceStorageKey);
      else localStorage.setItem(appearanceStorageKey, value);
    } catch {
      // Appearance is local and non-authoritative; persistence is optional.
    }
  }
  const resource = section === 'work' ? view : section;
  const clearPrivateSession = useCallback(() => {
    sessionEpoch.current++;
    identityInvalid.current = true;
    order.current.invalidate();
    detailOrder.current++;
    sessionKey.current = null;
    sessionId.current = '';
    received.current = 0;
    ttl.current = 0;
    acceptedRead.current = null;
    rowsRef.current = [];
    pending.current = [];
    setData(null);
    setRows([]);
    setDetail(null);
    setCreating(null);
    setUnconfirmed(null);
    setNewCount(0);
    setStale(true);
    setReading(false);
    setReadUnavailable(true);
    // Correlation remains private until a verified matching account is restored.
    // Neither the journal nor pendingCommand is cleared by invalidation.
  }, []);
  const load = useCallback(
    async (cursor?: string) => {
      if (!viewActive.current) return false;
      const initiatingView = viewGeneration.current;
      const currentView = () =>
        viewActive.current && viewGeneration.current === initiatingView;
      setReading(true);
      const ticket = order.current.issue();
      try {
        const next = await read(resource, {
          ...(query ? { q: query } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (!currentView() || !order.current.current(ticket)) return false;
        const nextKey = acceptedSessionKey(next);
        if (nextKey === null) {
          clearPrivateSession();
          setLoading(false);
          setError('SESSION_CONTEXT_UNAVAILABLE');
          return false;
        }
        let acceptanceTicket = ticket;
        if (sessionKey.current && sessionKey.current !== nextKey) {
          clearPrivateSession();
          // Projection ordering belongs to one verified session context.
          acceptanceTicket = order.current.issue();
          setNotice('Account changed. Private cached data cleared.');
        }
        if (!order.current.accept(acceptanceTicket, next.projection_version)) {
          setReading(false);
          return false;
        }
        sessionKey.current = nextKey;
        sessionId.current = next.session!.identity;
        identityInvalid.current = false;
        received.current = performance.now();
        ttl.current = Math.min(
          freshLifetime(next.server_time, next.fresh_until),
          next.session!.expires - Date.parse(next.server_time),
        );
        const journal = restoreCommandJournal(sessionId.current);
        const held =
          pendingCommand.current?.identity === sessionId.current
            ? pendingCommand.current
            : journal.pending;
        if (held) pendingCommand.current = held;
        setUnconfirmed(held);
        acceptedRead.current = { resource, query };
        setData(next);
        setReadUnavailable(false);
        setReading(false);
        setStale(false);
        setError(
          !journal.available ||
            (pendingCommand.current !== null && held === null)
            ? 'COMMAND_JOURNAL_UNAVAILABLE'
            : held
              ? 'REQUEST_UNCONFIRMED'
              : '',
        );
        pending.current = next.items;
        const count = rowsRef.current.length
          ? changedRows(rowsRef.current, next.items)
          : 0;
        setNewCount(frozen.current ? count : 0);
        const result = stableOrder(rowsRef.current, next.items, frozen.current);
        rowsRef.current = result;
        setRows(result);
        setLoading(false);
        return true;
      } catch (e) {
        if (!currentView() || !order.current.current(ticket)) return false;
        setLoading(false);
        setReading(false);
        setReadUnavailable(true);
        const code = e instanceof Error ? e.message : 'READ_UNAVAILABLE';
        setError(code);
        setStale(true);
        if (code === 'SESSION_EXPIRED') {
          clearPrivateSession();
        }
        return false;
      }
    },
    [resource, query, clearPrivateSession],
  );
  useEffect(() => {
    viewGeneration.current++;
    viewActive.current = true;
    order.current.invalidate();
    rowsRef.current = [];
    acceptedRead.current = null;
    setRows([]);
    setData(null);
    setDetail(null);
    setLoading(true);
    // A different resource/query has not failed yet. Same-scope retries retain
    // their diagnostic until load() accepts a response.
    setReadUnavailable(false);
    frozen.current = Boolean(selected);
    load();
    const interval = setInterval(() => {
      if (!document.hidden && navigator.onLine) load();
    }, 10000);
    return () => {
      viewActive.current = false;
      viewGeneration.current++;
      clearInterval(interval);
      order.current.invalidate();
      detailOrder.current++;
    };
  }, [load]);
  useEffect(() => {
    const timer = setInterval(
      () => setStale(performance.now() - received.current >= ttl.current),
      500,
    );
    const connection = () => {
        setOnline(navigator.onLine);
        if (!navigator.onLine) setStale(true);
        else load();
      },
      visible = () => {
        if (document.hidden) setStale(true);
        else {
          clearPrivateSession();
          load();
        }
      },
      channel = new BroadcastChannel('continuum-session');
    channel.onmessage = () => {
      clearPrivateSession();
      setError('SESSION_CHANGED');
    };
    window.addEventListener('online', connection);
    window.addEventListener('offline', connection);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      channel.close();
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load]);
  const inspect = useCallback(async () => {
    if (!selected || !viewActive.current) return;
    const initiatingView = viewGeneration.current;
    const currentView = () =>
      viewActive.current && viewGeneration.current === initiatingView;
    const current = ++detailOrder.current;
    const row = rowsRef.current.find((x) => x.id === selected);
    const target =
      section === 'work'
        ? ((row?.fields.target as string) ??
          (selected.startsWith('task:') ? selected.slice(5) : selected))
        : selected;
    try {
      const next = await read(
        section === 'evidence' && selected.startsWith('operation:')
          ? 'operation'
          : section === 'work'
            ? 'work'
            : section,
        {
          id:
            section === 'evidence' && selected.startsWith('operation:')
              ? selected.slice(10)
              : target,
        },
      );
      if (
        !currentView() ||
        current !== detailOrder.current ||
        identityInvalid.current
      )
        return;
      if (acceptedSessionKey(next) !== sessionKey.current) return;
      const item = next.items[0];
      if (!item) {
        setDetail(null);
        setNotice('Object unavailable in this authorized snapshot.');
        return;
      }
      let lifetime = Math.min(
        freshLifetime(next.server_time, next.fresh_until),
        next.session!.expires - Date.parse(next.server_time),
      );
      if (typeof item.fields.maximumApprovalExpiry === 'string')
        lifetime = Math.min(
          lifetime,
          Date.parse(item.fields.maximumApprovalExpiry) -
            Date.parse(next.server_time),
        );
      setDetail({
        item,
        envelope: next,
        at: performance.now(),
        ttl: Math.max(0, lifetime),
      });
    } catch {
      if (currentView() && current === detailOrder.current)
        setNotice('Exact detail unavailable. No action is enabled.');
    }
  }, [selected, section]);
  useEffect(() => {
    frozen.current = Boolean(selected);
    setCreating(null);
    setDetail(null);
    if (selected && data) inspect();
  }, [selected, section, data?.session?.identity, inspect]);
  const eligible =
    Boolean(data) &&
    (!error || error === 'REQUEST_UNCONFIRMED') &&
    data?.session?.fresh_mfa === true &&
    canMutate(
      data?.features.commands?.state === 'available' && !stale,
      received.current,
      ttl.current,
      performance.now(),
      online,
      document.visibilityState === 'hidden',
    ) &&
    !identityInvalid.current;
  const allowed = eligible && !unconfirmed && !pendingCommand.current;
  const detailAllowed =
    allowed &&
    Boolean(detail) &&
    detail?.envelope.features.commands?.state === 'available' &&
    detail?.envelope.session?.fresh_mfa === true &&
    performance.now() - (detail?.at ?? 0) < (detail?.ttl ?? 0);
  function releaseCommand(reference: PendingCommand) {
    const cleared = clearCommandJournal(reference);
    if (
      pendingCommand.current?.identity === reference.identity &&
      pendingCommand.current.key === reference.key
    ) {
      pendingCommand.current = null;
      setUnconfirmed(null);
    }
    return cleared;
  }
  async function issue(value: HumanCommand): Promise<CommandOutcome> {
    if (
      !viewActive.current ||
      !allowed ||
      busy ||
      submitting.current ||
      pendingCommand.current
    ) {
      setNotice('Refresh and revalidate current eligibility before acting.');
      return 'UNAVAILABLE';
    }
    const initiatingIdentity = sessionId.current;
    const initiatingKey = sessionKey.current;
    const initiatingEpoch = sessionEpoch.current;
    const initiatingView = viewGeneration.current;
    const sameContext = () =>
      viewActive.current &&
      viewGeneration.current === initiatingView &&
      !identityInvalid.current &&
      sessionId.current === initiatingIdentity &&
      sessionKey.current === initiatingKey &&
      sessionEpoch.current === initiatingEpoch;
    const reference = {
      identity: initiatingIdentity,
      key: value.idempotency_key,
    };
    if (!rememberCommand(reference)) {
      setError('COMMAND_JOURNAL_UNAVAILABLE');
      setNotice(
        'Browser command tracking is unavailable. No request was submitted. Restore tab storage before acting.',
      );
      return 'UNAVAILABLE';
    }
    pendingCommand.current = reference;
    setUnconfirmed(reference);
    submitting.current = true;
    setBusy(true);
    setNotice(
      'Submitting reviewed human command. No external success is inferred.',
    );
    try {
      const result = await command(value, data!.csrf);
      if (!sameContext()) {
        // Keep correlation for GET-only recovery in the current or next view.
        return 'UNAVAILABLE';
      }
      const journalReady = releaseCommand(reference);
      if (result.status === 'APPLIED') {
        setNotice(
          value.kind === 'approve'
            ? 'Exact approval recorded. Execution and verification are separate.'
            : value.kind === 'revoke_grant'
              ? 'Grant revoked. Previously admitted effects may still finish.'
              : value.kind === 'create_task'
                ? 'Task recorded. No workflow or external action was started.'
                : value.kind === 'create_project'
                  ? 'Project recorded. No work, approval, authority or external action was created.'
                  : value.kind === 'link_task_project'
                    ? 'Project link recorded. Work and effect bindings remain unchanged.'
                    : value.kind === 'create_vera'
                      ? 'VERA profile recorded in PAUSED mode and requires setup. No workload, Computer, model or effect authority was created.'
                      : value.kind === 'update_vera_profile'
                        ? 'Profile text updated. Principal identity and authority remain unchanged.'
                        : value.kind === 'ack_incident'
                          ? 'Incident acknowledged, not resolved.'
                          : value.kind === 'mark_notification_read'
                            ? 'Notification read; incident remains unchanged.'
                            : value.kind === 'assign'
                              ? 'Workload assignment recorded. Issuance, admission and verification remain separate.'
                              : 'Human command durably applied; not external success.',
        );
        if (value.kind === 'export_evidence') {
          const blob = new Blob([JSON.stringify(result.result, null, 2)], {
              type: 'application/json',
            }),
            url = URL.createObjectURL(blob),
            a = document.createElement('a');
          a.href = url;
          a.download = 'continuum-selected-evidence.json';
          a.click();
          URL.revokeObjectURL(url);
        }
        setCreating(null);
        frozen.current = Boolean(selected);
        if (!journalReady) setError('COMMAND_JOURNAL_UNAVAILABLE');
        const refreshed = await load();
        if (!refreshed || !sameContext()) return 'APPLIED';
        if (
          (value.kind === 'create_vera' && section === 'agents') ||
          (value.kind === 'create_project' && section === 'projects')
        )
          choose(value.target);
        else await inspect();
        return 'APPLIED';
      } else {
        setNotice(
          'Command denied: the current binding, version or authority changed. Refresh the exact review.',
        );
        setStale(true);
        setError(
          journalReady ? 'STALE_COMMAND' : 'COMMAND_JOURNAL_UNAVAILABLE',
        );
        setDetail(null);
        setCreating(null);
        return 'DENIED';
      }
    } catch (e) {
      if (!sameContext()) return 'UNAVAILABLE';
      if (e instanceof Error && e.message === 'SESSION_EXPIRED') {
        const refused =
          'commandNotSubmitted' in e && e.commandNotSubmitted === true;
        if (refused) releaseCommand(reference);
        identityInvalid.current = true;
        order.current.invalidate();
        detailOrder.current++;
        setData(null);
        setDetail(null);
        setRows([]);
        rowsRef.current = [];
        setCreating(null);
        setUnconfirmed(null);
        setError('SESSION_EXPIRED');
        setNotice(
          refused
            ? 'Session expired. Server refused the unauthenticated request. Private data cleared; sign in and refresh.'
            : 'Session expired. Private data cleared. Sign in and check the stored command outcome before submitting again.',
        );
        return 'SESSION_EXPIRED';
      } else {
        setError('REQUEST_UNCONFIRMED');
        setNotice(
          'Request outcome unconfirmed. Lookup did not establish a result. Do not blindly resubmit.',
        );
        return 'UNCONFIRMED';
      }
    } finally {
      submitting.current = false;
      if (viewActive.current) setBusy(false);
    }
  }
  async function issueSafely(value: HumanCommand) {
    await issue(value);
  }
  async function issueForm(value: HumanCommand) {
    const outcome = await issue(value);
    if (outcome !== 'APPLIED' && outcome !== 'DENIED')
      throw Error(outcome === 'UNCONFIRMED' ? 'REQUEST_UNCONFIRMED' : outcome);
  }
  async function checkStoredOutcome() {
    const held = pendingCommand.current;
    if (
      !held ||
      !viewActive.current ||
      !eligible ||
      busy ||
      submitting.current ||
      held.identity !== sessionId.current
    )
      return;
    const initiatingKey = sessionKey.current;
    const initiatingEpoch = sessionEpoch.current;
    const initiatingView = viewGeneration.current;
    const sameContext = () =>
      viewActive.current &&
      viewGeneration.current === initiatingView &&
      !identityInvalid.current &&
      sessionId.current === held.identity &&
      sessionKey.current === initiatingKey &&
      sessionEpoch.current === initiatingEpoch;
    submitting.current = true;
    setBusy(true);
    try {
      const result = await lookupCommand(held.key);
      if (!sameContext()) return;
      const journalReady = releaseCommand(held);
      setCreating(null);
      frozen.current = Boolean(selected);
      setNotice(
        result.status === 'APPLIED'
          ? 'Stored human-command receipt found: applied. This is not execution or external success.'
          : 'Stored human-command receipt found: denied. Review fresh state before a new request.',
      );
      setError(journalReady ? '' : 'COMMAND_JOURNAL_UNAVAILABLE');
      const refreshed = await load();
      if (!refreshed || !sameContext()) return;
      await inspect();
    } catch (error) {
      if (!sameContext()) return;
      if (error instanceof Error && error.message === 'SESSION_EXPIRED') {
        clearPrivateSession();
      }
      setError(
        error instanceof Error && error.message === 'SESSION_EXPIRED'
          ? 'SESSION_EXPIRED'
          : 'REQUEST_UNCONFIRMED',
      );
      setNotice(
        'Stored outcome is still unconfirmed. Only a lookup was attempted; no command was posted or resent.',
      );
      setStale(true);
    } finally {
      submitting.current = false;
      if (viewActive.current) setBusy(false);
    }
  }
  function closeForm() {
    setCreating(null);
    frozen.current = Boolean(selected);
  }
  function choose(id: string) {
    const q = new URLSearchParams(params);
    q.set('selected', id);
    router.push('/console/' + section + '?' + q, { scroll: false });
    frozen.current = true;
    setCreating(null);
  }
  function back() {
    const q = new URLSearchParams(params);
    q.delete('selected');
    router.push('/console/' + section + '?' + q, { scroll: false });
    frozen.current = false;
    setDetail(null);
    setCreating(null);
  }
  async function logout() {
    if (data)
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-ct-csrf': data.csrf },
      });
    new BroadcastChannel('continuum-session').postMessage('changed');
    location.assign('/sign-in');
  }
  let workPage: ReadEnvelope | null = null;
  if (
    data &&
    resource === 'work' &&
    acceptedRead.current?.resource === resource &&
    acceptedRead.current.query === query
  ) {
    // One accepted page, not stableOrder rows. The read-only leaf never receives CSRF.
    const { csrf: _csrf, ...page } = data;
    workPage = page;
  }
  const links = navGroups.map(({ label, items }) => (
    <div className="nav-group" role="group" aria-label={label} key={label}>
      <p className="nav-heading" aria-hidden>
        {label}
      </p>
      {items.map(([id, title]) => (
        <Link
          key={id}
          href={'/console/' + id}
          aria-current={section === id ? 'page' : undefined}
          className={section === id ? 'active' : ''}
        >
          <span className="nav-glyph" aria-hidden>
            {id === 'work'
              ? '◈'
              : id === 'approvals'
                ? '✓'
                : id === 'agents'
                  ? '◇'
                  : '·'}
          </span>
          {title}
        </Link>
      ))}
    </div>
  ));
  return (
    <div className="console" data-appearance={appearance}>
      <a href="#work-main" className="skip-link">
        Skip to workspace
      </a>
      <aside className="sidebar" aria-label="Main navigation">
        <Link className="brand" href="/console/work">
          <span className="brand-mark" aria-hidden>
            C
          </span>
          <span>
            ASENTXIA<small>CONTINUUM</small>
          </span>
        </Link>
        <nav>{links}</nav>
        <div className="sidebar-footer">
          <p className="small">
            One authority home.
            <br />
            No blind retries.
          </p>
          <span className="muted small">
            Development console · not production
          </span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-start">
            <details className="mobile-nav">
              <summary>Continuum navigation</summary>
              <nav>{links}</nav>
            </details>
            <div className="breadcrumb">
              <span className="workspace-name">
                {data?.session?.tenant
                  ? 'Workspace ' + data.session.tenant
                  : 'Continuum workspace'}
              </span>
              <span className="breadcrumb-divider" aria-hidden>
                /
              </span>
              <span>{titles[section]}</span>
            </div>
          </div>
          <div className="topbar-end">
            <div className="appearance">
              <label htmlFor="console-appearance">Appearance</label>
              <select
                id="console-appearance"
                value={appearance}
                onChange={(e) => changeAppearance(e.currentTarget.value)}
                aria-describedby="appearance-help"
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
              <span id="appearance-help" className="sr-only">
                Local appearance only. Does not change authority or release
                readiness.
              </span>
            </div>
            <span className="mode">
              {mode === 'LOCAL_FIXTURE' ? 'LOCAL TEST' : 'STAGING'}
            </span>
            <button className="quiet" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <div className="release-banner" role="note">
          <span>Production blocked · Scheduler held · Canary no-go</span>
          <Link href="/console/setup">View readiness</Link>
        </div>
        {unconfirmed && !busy && (
          <section
            className="degraded-banner"
            aria-label="Unconfirmed human command"
          >
            <div>
              <strong>Command outcome unconfirmed</strong>
              <p>
                New commands are held. Check the stored receipt; never blindly
                resubmit. Reference: <code>{unconfirmed.key}</code>
              </p>
            </div>
            <button disabled={!eligible || busy} onClick={checkStoredOutcome}>
              Check stored command outcome
            </button>
          </section>
        )}
        {(error || stale || !online) && (
          <div className="degraded-banner" role="alert">
            {error === 'SESSION_EXPIRED' ||
            error === 'SESSION_CHANGED' ||
            error === 'SESSION_CONTEXT_UNAVAILABLE' ? (
              <>
                Session expired or changed. Private cached data cleared.{' '}
                <Link href="/sign-in">Sign in again</Link>
              </>
            ) : error === 'UNKNOWN_SCHEMA' ? (
              'Update needed: unknown response schema. Controls are unavailable.'
            ) : error === 'REQUEST_UNCONFIRMED' ? (
              'Human command outcome is unconfirmed. This is not an external effect outcome.'
            ) : error === 'COMMAND_JOURNAL_UNAVAILABLE' ? (
              'Browser command tracking is unavailable. Controls stay held; no new command is submitted.'
            ) : !online ? (
              'Offline. Displayed data may be stale; commands are unavailable.'
            ) : (
              'Data is stale or unavailable. No all-clear or effect outcome is inferred.'
            )}
            <button onClick={() => load()}>Refresh authorized snapshot</button>
          </div>
        )}
        <main id="work-main" className="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                CONTINUUM /{' '}
                {mode === 'LOCAL_FIXTURE' ? 'TEST WORKSPACE' : 'STAGING'}
              </p>
              <h1>{titles[section]}</h1>
              <p className="subtitle">
                {descriptions[section] ??
                  'Authoritative records, explicit availability and contextual detail.'}
              </p>
            </div>
            <div className="heading-actions">
              {['work', 'authority', 'projects', 'agents'].includes(
                section,
              ) && (
                <button
                  className="primary"
                  disabled={!allowed || busy}
                  onClick={() => {
                    setCreating(
                      section === 'work'
                        ? 'task'
                        : section === 'authority'
                          ? 'grant'
                          : section === 'projects'
                            ? 'project'
                            : 'vera',
                    );
                    setDetail(null);
                    frozen.current = true;
                  }}
                >
                  {section === 'work'
                    ? 'New task'
                    : section === 'authority'
                      ? 'New bounded grant'
                      : section === 'projects'
                        ? 'New project'
                        : 'New VERA'}
                </button>
              )}
            </div>
          </div>
          <div className="toolbar">
            {section === 'work' && (
              <div className="view-switch" aria-label="Work view">
                <button
                  className={view === 'focus' ? 'selected' : ''}
                  onClick={() => setView('focus')}
                >
                  Needs attention
                </button>
                <button
                  className={view === 'work' ? 'selected' : ''}
                  onClick={() => setView('work')}
                >
                  All work
                </button>
              </div>
            )}
            {section === 'work' && view === 'work' && (
              <div
                className="view-switch"
                role="group"
                aria-label="All work presentation"
              >
                <button
                  className={workPresentation === 'list' ? 'selected' : ''}
                  aria-pressed={workPresentation === 'list'}
                  onClick={() => setWorkPresentation('list')}
                >
                  List
                </button>
                <button
                  className={workPresentation === 'map' ? 'selected' : ''}
                  aria-pressed={workPresentation === 'map'}
                  onClick={() => setWorkPresentation('map')}
                >
                  Map
                </button>
              </div>
            )}
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                const q = new URLSearchParams();
                if (draftQ) q.set('q', draftQ);
                router.push('/console/' + section + '?' + q);
              }}
            >
              <label className="sr-only" htmlFor="work-search">
                Search authorized {titles[section]}
              </label>
              <input
                id="work-search"
                placeholder="Search authorized records"
                value={draftQ}
                onChange={(e) => setDraftQ(e.target.value)}
                maxLength={128}
              />
              <button type="submit">Search</button>
            </form>
            <button
              onClick={() => {
                frozen.current = false;
                rowsRef.current = pending.current;
                setRows(pending.current);
                setNewCount(0);
                load();
              }}
            >
              Refresh order{newCount ? ' · ' + newCount + ' new' : ''}
            </button>
          </div>
          {newCount > 0 && (
            <p className="arrival-notice" role="status" aria-live="polite">
              {newCount} new attention group{newCount === 1 ? '' : 's'}. Review
              order stays fixed until you refresh it.
            </p>
          )}
          <div
            className={
              'desk-grid ' + (selected || creating ? 'has-detail' : '')
            }
          >
            <section
              className={
                'work-list ' + (selected || creating ? 'mobile-hidden' : '')
              }
              aria-label={titles[section] + ' records'}
            >
              <div className="list-heading">
                <span>
                  {loading
                    ? 'Loading authorized records'
                    : !data
                      ? 'Count unavailable'
                      : data.total === null
                        ? 'Count unknown'
                        : `${data.total} ${section === 'work' && view === 'focus' ? 'attention groups' : 'records'}`}
                </span>
                <span className="muted">
                  {data?.completeness === 'partial'
                    ? 'Partial snapshot'
                    : 'Authorized snapshot'}
                </span>
              </div>
              {section === 'work' &&
              view === 'work' &&
              workPresentation === 'map' ? (
                <WorkMap
                  envelope={workPage}
                  loading={loading || reading}
                  stale={stale}
                  offline={!online}
                  readUnavailable={readUnavailable}
                  selectedTaskId={
                    selected.startsWith('task:') ? selected.slice(5) : selected
                  }
                  onInspectTask={(id) => choose('task:' + id)}
                />
              ) : loading ? (
                <div className="empty" role="status">
                  Loading durable state…
                </div>
              ) : !rows.length ? (
                <div className="empty">
                  {error || stale
                    ? 'Records unavailable. This is not an empty or all-clear result.'
                    : 'No items in this authorized view.'}
                </div>
              ) : (
                <ul className="records">
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        className={
                          'record ' +
                          (selected === row.id ? 'record-selected' : '')
                        }
                        onClick={() => choose(row.id)}
                        aria-label={row.title + ' · ' + row.status}
                      >
                        <div className="record-main">
                          <span className="record-title">{row.title}</span>
                          <span className="record-reason">
                            {String(
                              row.fields.why ??
                                row.subtitle ??
                                (row.kind === 'task'
                                  ? row.fields.accountableVERA
                                  : row.id),
                            )}
                          </span>
                        </div>
                        <div className="record-state">
                          <Badge value={row.status} />
                          {row.kind === 'focus' && (
                            <span className="muted small">
                              {String(row.fields.affectedCount)} affected ·
                              priority {String(row.fields.severity)}
                            </span>
                          )}
                        </div>
                        <span className="row-arrow" aria-hidden>
                          ↗
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {data?.cursor && (
                <div className="list-footer">
                  <button
                    onClick={() => {
                      frozen.current = false;
                      load(data.cursor!);
                    }}
                  >
                    Next authorized page
                  </button>
                  <span className="muted small">
                    Bound to tenant, filters and snapshot version.
                  </span>
                </div>
              )}
              {section === 'evidence' && rows.length > 0 && (
                <div className="list-footer">
                  <button
                    disabled={!allowed || busy}
                    onClick={() =>
                      issue({
                        schema_version: 1,
                        idempotency_key: crypto.randomUUID(),
                        kind: 'export_evidence',
                        target: 'selected-evidence',
                        expected_version: data!.projection_version,
                        input: {
                          sequences: rows.map((x) => x.version),
                          snapshot: data!.projection_version,
                        },
                      })
                    }
                  >
                    Export this authorized page
                  </button>
                  <span className="small muted">
                    Selected-page export, not a complete archive.
                  </span>
                </div>
              )}
            </section>
            <aside
              className={
                'inspector ' + (selected || creating ? 'mobile-detail' : '')
              }
              aria-label="Contextual inspector"
            >
              {selected || creating ? (
                <button className="back-button" onClick={back}>
                  ← Back to {titles[section]}
                </button>
              ) : null}
              {creating === 'project' ? (
                <CreateProjectForm
                  canAct={allowed}
                  busy={busy}
                  onCommand={issueForm}
                  onClose={closeForm}
                />
              ) : creating === 'vera' || creating === 'edit_vera' ? (
                <VeraProfileForm
                  mode={creating === 'vera' ? 'create' : 'edit'}
                  item={creating === 'edit_vera' ? detail?.item : undefined}
                  canAct={creating === 'edit_vera' ? detailAllowed : allowed}
                  busy={busy}
                  onCommand={issueForm}
                  onClose={closeForm}
                />
              ) : creating === 'link_project' ? (
                detail ? (
                  <LinkTaskProjectForm
                    item={detail.item}
                    context={detail.envelope}
                    contextDeadline={detail.at + detail.ttl}
                    canAct={detailAllowed}
                    busy={busy}
                    onCommand={issueForm}
                    onClose={closeForm}
                  />
                ) : (
                  <p>
                    Exact work snapshot unavailable. Refresh before linking.
                  </p>
                )
              ) : creating === 'task' || creating === 'grant' ? (
                <CreationForm
                  kind={creating}
                  canAct={allowed}
                  busy={busy}
                  onCommand={issueSafely}
                  onClose={closeForm}
                  serverTime={data?.server_time ?? new Date().toISOString()}
                />
              ) : detail ? (
                <>
                  {section === 'agents' && detail.item.kind === 'vera' && (
                    <div className="actions">
                      <button
                        disabled={
                          !detailAllowed ||
                          busy ||
                          typeof detail.item.fields.profileRevision !==
                            'number' ||
                          !Number.isSafeInteger(
                            detail.item.fields.profileRevision,
                          ) ||
                          detail.item.fields.profileRevision < 1 ||
                          detail.item.fields.profileRevision >
                            Number.MAX_SAFE_INTEGER - 1
                        }
                        onClick={() => setCreating('edit_vera')}
                      >
                        Edit VERA profile
                      </button>
                      {detail.item.fields.profileRevision == null && (
                        <p className="muted small">
                          Historical principal has no editable profile. It
                          cannot be adopted by this command.
                        </p>
                      )}
                    </div>
                  )}
                  {section === 'work' && detail.item.kind === 'task' && (
                    <div className="actions">
                      <button
                        disabled={
                          !detailAllowed ||
                          busy ||
                          typeof detail.item.fields.coordinationRevision !==
                            'number' ||
                          !Number.isSafeInteger(
                            detail.item.fields.coordinationRevision,
                          ) ||
                          detail.item.fields.coordinationRevision < 0 ||
                          detail.item.fields.coordinationRevision >
                            Number.MAX_SAFE_INTEGER - 1
                        }
                        onClick={() => setCreating('link_project')}
                      >
                        Link work to project
                      </button>
                    </div>
                  )}
                  <ReviewPanel
                    item={detail.item}
                    canAct={detailAllowed}
                    busy={busy}
                    onCommand={issueSafely}
                    onRefresh={inspect}
                  />
                </>
              ) : (
                <div className="inspector-empty">
                  <span className="inspector-symbol" aria-hidden>
                    ◇
                  </span>
                  <h2>
                    {selected
                      ? 'Loading exact detail'
                      : 'Details when you need them'}
                  </h2>
                  <p>
                    Choose work, a decision or a durable record. Identity,
                    authority and evidence stay connected without crowding the
                    default view.
                  </p>
                  <p className="muted small">
                    No provider credential or machine-renewal control belongs in
                    this console.
                  </p>
                </div>
              )}
            </aside>
          </div>
          <div className="command-status" role="status" aria-live="polite">
            {notice ||
              'Review durable state. Every enabled command is checked again on the server.'}
          </div>
          <footer className="snapshot-footer">
            <span>
              Source {data?.source_revision ?? 'not observed'} · snapshot{' '}
              {data?.projection_version ?? 'unknown'}
            </span>
            <span>
              {mode === 'LOCAL_FIXTURE'
                ? 'Local evidence is not a live qualification pass.'
                : 'Qualification scope stays independent from UI availability.'}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
