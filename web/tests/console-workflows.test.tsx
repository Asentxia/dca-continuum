import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvelopeSchema, type ConsoleItem } from '@continuum/contracts';
import { ConsoleApp } from '../components/ConsoleApp';
import { command, lookupCommand, read } from '@/lib/api';
import { commandJournalKey, rememberCommand } from '../lib/command-journal';

const navigation = vi.hoisted(() => ({
  selected: '',
  query: '',
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () =>
    new URLSearchParams({
      ...(navigation.query ? { q: navigation.query } : {}),
      ...(navigation.selected ? { selected: navigation.selected } : {}),
    }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock('@/lib/api', () => ({
  read: vi.fn(),
  command: vi.fn(),
  lookupCommand: vi.fn(),
}));

let rows: ConsoleItem[];
let choices: ConsoleItem[];
let identity: string;
let detailCommands: boolean;
let sessionChannel: {
  onmessage: ((event: MessageEvent) => void) | null;
} | null;
function vera(revision: number | null = 7): ConsoleItem {
  return {
    id: 'vera-a',
    kind: 'vera',
    title: 'Original profile',
    version: 41,
    status: 'Paused VERA',
    fields: {
      VERA: 'vera-a',
      profileRevision: revision,
      profileName: revision === null ? null : 'Original profile',
      description: revision === null ? null : 'Original description',
      profileCreatedBy: revision === null ? null : 'owner-a',
      principalEpoch: 41,
      principalGeneration: 9,
      executionMode: 'PAUSED',
    },
  };
}
function project(): ConsoleItem {
  return {
    id: 'project-existing',
    kind: 'project',
    title: 'Existing project',
    version: 1,
    status: 'Read-only project registry',
    fields: { objective: 'Organize only', tasks: [] },
  };
}
function work(): ConsoleItem {
  return {
    id: 'task-a',
    kind: 'task',
    title: 'Existing work',
    version: 29,
    status: 'Outcome uncertain',
    fields: {
      coordinationRevision: 4,
      accountableVERA: 'vera-a',
      originalPrincipal: 'vera-a',
      project: null,
      dependencies: [],
      operations: [{ id: 'operation-a', state: 'UNKNOWN' }],
      workflow: 'No workflow admission inferred from task creation',
    },
  };
}
function envelope(items: ConsoleItem[], available = true) {
  const now = Date.now();
  return {
    ...EnvelopeSchema.parse({
      schema_version: 1,
      server_time: new Date(now).toISOString(),
      observed_at: new Date(now).toISOString(),
      fresh_until: new Date(now + 60000).toISOString(),
      projection_version: 5,
      source_revision: 'workflow-unit-only',
      completeness: 'complete',
      cursor: null,
      total: items.length,
      items,
      features: {
        commands: {
          state: available ? 'available' : 'qualification_pending',
          reason: available
            ? 'Fresh enrolled test owner'
            : 'Current commands denied',
          scope: 'LOCAL_FIXTURE',
        },
      },
      scope: 'LOCAL_FIXTURE',
      session: {
        identity,
        tenant: 'a',
        principal: null,
        expires: now + 60000,
        fresh_mfa: true,
      },
    }),
    csrf: 'unit-marker',
  };
}
function receipt(key: string, status: 'APPLIED' | 'DENIED' = 'APPLIED') {
  return {
    schema_version: 1 as const,
    command_id: 'b0c3a8b2-8e41-4313-b00c-bfcf0535d599',
    idempotency_key: key,
    status,
    result_ref: 'b0c3a8b2-8e41-4313-b00c-bfcf0535d599',
    result: {
      externalEffect: false,
      effectAuthority: false,
      workflowAdmitted: false,
    },
    error_code: status === 'DENIED' ? 'CURRENT_STATE_DENIED' : null,
    reused: false,
    external_effect: false as const,
  };
}
beforeEach(() => {
  sessionStorage.clear();
  navigation.selected = '';
  navigation.query = '';
  navigation.push.mockReset();
  rows = [];
  choices = [project()];
  identity = 'owner-a';
  detailCommands = true;
  sessionChannel = null;
  vi.mocked(read)
    .mockReset()
    .mockImplementation(async (section, query = {}) =>
      envelope(
        section === 'projects' && rows[0]?.kind === 'task'
          ? choices
          : query.id
            ? rows.filter((item) => item.id === query.id)
            : rows,
        query.id ? detailCommands : true,
      ),
    );
  vi.mocked(command)
    .mockReset()
    .mockImplementation(async (value) => receipt(value.idempotency_key));
  vi.mocked(lookupCommand).mockReset();
  vi.spyOn(globalThis, 'setInterval').mockReturnValue(
    1 as unknown as ReturnType<typeof setInterval>,
  );
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        sessionChannel = this;
      }
      close() {}
      postMessage() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open(section: string) {
  const view = render(<ConsoleApp section={section} mode="LOCAL_FIXTURE" />);
  await screen.findByText('Authorized snapshot');
  return view;
}
async function projectDraft() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'New project' }));
  await user.type(
    screen.getByRole('textbox', { name: 'Project name' }),
    'Durable project',
  );
  return user;
}
async function enterWorkMap() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'All work' }));
  await screen.findByRole('button', { name: 'Map' });
  await user.click(screen.getByRole('button', { name: 'Map' }));
  await screen.findByRole('heading', { name: 'Work relationships' });
  await waitFor(() =>
    expect(
      screen
        .getByRole('region', { name: 'Work relationships' })
        .getAttribute('aria-busy'),
    ).toBe('false'),
  );
  return user;
}
async function pollAuthorizedPage() {
  const poll = vi
    .mocked(setInterval)
    .mock.calls.filter(([, ms]) => ms === 10000)
    .at(-1)?.[0];
  expect(typeof poll).toBe('function');
  await act(async () => {
    (poll as () => void)();
  });
}

describe('real console forms and durable human-command outcomes', () => {
  it('records a VERA through the parent command seam, not lifecycle or machine APIs', async () => {
    await open('agents');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New VERA' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Name' }),
      'Sable profile',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      'Research only',
    );
    await user.click(
      screen.getByRole('button', { name: 'Record VERA profile' }),
    );
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const request = vi.mocked(command).mock.calls[0][0];
    expect(request).toMatchObject({
      kind: 'create_vera',
      expected_version: 0,
      input: { name: 'Sable profile', description: 'Research only' },
    });
    expect(Object.keys(request.input).sort()).toEqual(['description', 'name']);
    await screen.findByText(/VERA profile recorded in PAUSED mode/);
    expect(navigation.push).toHaveBeenCalledWith(
      '/console/agents?selected=' + request.target,
      { scroll: false },
    );
    expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
    expect(lookupCommand).not.toHaveBeenCalled();
  });
  it('profile editing uses the loaded profile revision, never principal epoch', async () => {
    rows = [vera()];
    navigation.selected = 'vera-a';
    await open('agents');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit VERA profile',
      }),
    );
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Renamed profile');
    await user.click(
      screen.getByRole('button', {
        name: 'Record profile changes',
      }),
    );
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(vi.mocked(command).mock.calls[0][0]).toMatchObject({
      kind: 'update_vera_profile',
      target: 'vera-a',
      expected_version: 7,
      input: { name: 'Renamed profile', description: 'Original description' },
    });
  });
  it('a historical unprofiled principal has no adoption or edit command', async () => {
    rows = [vera(null)];
    navigation.selected = 'vera-a';
    await open('agents');
    const edit = await screen.findByRole('button', {
      name: 'Edit VERA profile',
    });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/Historical principal has no editable profile/),
    ).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
  });
  it('a denied exact-detail envelope cannot enable profile editing from a still-fresh list', async () => {
    rows = [vera()];
    navigation.selected = 'vera-a';
    detailCommands = false;
    await open('agents');
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Edit VERA profile',
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });
  it('project linking uses the loaded coordination revision without changing task or effect facts', async () => {
    const task = work();
    const before = structuredClone(task);
    rows = [task];
    navigation.selected = task.id;
    await open('work');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Link work to project' }),
    );
    const form = screen.getByRole('form', {
      name: 'Link existing work to a project',
    });
    const select = await within(form).findByRole('combobox');
    await waitFor(() =>
      expect(
        within(form).getByRole('option', { name: /Existing project/ }),
      ).toBeTruthy(),
    );
    await user.selectOptions(select, 'project-existing');
    await user.click(
      within(form).getByRole('button', { name: 'Submit project link request' }),
    );
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(vi.mocked(command).mock.calls[0][0]).toMatchObject({
      kind: 'link_task_project',
      target: 'task-a',
      expected_version: 4,
      input: { project: 'project-existing' },
    });
    expect(task).toEqual(before);
    expect(lookupCommand).not.toHaveBeenCalled();
  });
  it('unknown reply remains held after a fresh read and resolves only through lookup', async () => {
    vi.mocked(command).mockRejectedValue(new Error('REQUEST_UNCONFIRMED'));
    await open('projects');
    const user = await projectDraft();
    await user.click(
      screen.getByRole('button', {
        name: 'Submit project request',
      }),
    );
    await screen.findByText('Command outcome unconfirmed');
    const request = vi.mocked(command).mock.calls[0][0];
    expect(JSON.parse(sessionStorage.getItem(commandJournalKey)!)).toEqual({
      identity: 'owner-a',
      key: request.idempotency_key,
    });
    await user.click(
      screen.getByRole('button', {
        name: 'Refresh authorized snapshot',
      }),
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'New project',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(command).toHaveBeenCalledTimes(1);
    vi.mocked(lookupCommand).mockResolvedValue(
      receipt(request.idempotency_key),
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Check stored command outcome',
      }),
    );
    await screen.findByText(/Stored human-command receipt found: applied/);
    expect(lookupCommand).toHaveBeenCalledExactlyOnceWith(
      request.idempotency_key,
    );
    expect(command).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'New project',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it('reload restores a same-account lookup reference without posting a command', async () => {
    rememberCommand({ identity: 'owner-a', key: 'held-request' });
    await open('projects');
    await screen.findByText('Command outcome unconfirmed');
    expect(
      (
        screen.getByRole('button', {
          name: 'New project',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    vi.mocked(lookupCommand).mockResolvedValue(
      receipt('held-request', 'DENIED'),
    );
    await userEvent.setup().click(
      screen.getByRole('button', {
        name: 'Check stored command outcome',
      }),
    );
    await screen.findByText(/Stored human-command receipt found: denied/);
    expect(lookupCommand).toHaveBeenCalledExactlyOnceWith('held-request');
    expect(command).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
  });
  it('inaccessible tracking prevents any submission instead of inventing an empty history', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw Error('blocked');
    });
    await open('projects');
    expect(
      (
        screen.getByRole('button', {
          name: 'New project',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Browser command tracking is unavailable/),
    ).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
  });
  it('tracking write failure is checked before the first POST', async () => {
    await open('projects');
    const user = await projectDraft();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('quota exceeded');
    });
    await user.click(
      screen.getByRole('button', { name: 'Submit project request' }),
    );
    await screen.findByText(/No request was submitted/);
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
  });
  it('malformed tracking remains held rather than silently becoming an empty command history', async () => {
    const raw =
      '{"identity":"owner-a","key":"held-key","claimedAuthority":true}';
    sessionStorage.setItem(commandJournalKey, raw);
    await open('projects');
    expect(
      (screen.getByRole('button', { name: 'New project' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Browser command tracking is unavailable/),
    ).toBeTruthy();
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
  });
  it('read session expiry clears an open private draft as well as cached records', async () => {
    await open('agents');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New VERA' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Name' }),
      'Private draft text',
    );
    vi.mocked(read).mockRejectedValue(new Error('SESSION_EXPIRED'));
    await user.click(screen.getByRole('button', { name: 'Refresh order' }));
    await screen.findByText(/Session expired or changed/);
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(
      screen.queryByRole('form', { name: 'Record a VERA profile' }),
    ).toBeNull();
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
  });
  it('lookup session expiry clears private rows but retains the original correlation for reauthentication', async () => {
    rows = [vera()];
    rememberCommand({ identity: 'owner-a', key: 'held-private-request' });
    await open('agents');
    vi.mocked(lookupCommand).mockRejectedValue(new Error('SESSION_EXPIRED'));
    await userEvent.setup().click(
      screen.getByRole('button', {
        name: 'Check stored command outcome',
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Original profile · Paused VERA',
        }),
      ).toBeNull(),
    );
    expect(screen.getByText(/Session expired or changed/)).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(commandJournalKey)!)).toEqual({
      identity: 'owner-a',
      key: 'held-private-request',
    });
  });
  it.each(['missing', 'empty'] as const)(
    'a %s read identity cannot erase a held request or permit a new POST',
    async (state) => {
      const held = { identity: 'owner-a', key: 'identity-gap-request' };
      rememberCommand(held);
      const raw = sessionStorage.getItem(commandJournalKey);
      await open('projects');
      await screen.findByText('Command outcome unconfirmed');
      const good = envelope([]);
      const unsupported = {
        ...good,
        session:
          state === 'missing' ? undefined : { ...good.session!, identity: '' },
      };
      const { csrf: _csrf, ...wire } = unsupported;
      expect(EnvelopeSchema.safeParse(wire).success).toBe(true);
      vi.mocked(read).mockResolvedValueOnce(unsupported);
      const user = userEvent.setup();
      await user.click(
        screen.getByRole('button', { name: 'Refresh authorized snapshot' }),
      );
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
      expect(screen.queryByText(held.key)).toBeNull();
      expect(
        (
          screen.getByRole('button', {
            name: 'New project',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      vi.mocked(read).mockResolvedValueOnce(good);
      await user.click(
        screen.getByRole('button', { name: 'Refresh authorized snapshot' }),
      );
      await screen.findByText(held.key);
      expect(
        (
          screen.getByRole('button', {
            name: 'New project',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(command).not.toHaveBeenCalled();
      expect(lookupCommand).not.toHaveBeenCalled();
      vi.mocked(lookupCommand).mockResolvedValue(receipt(held.key, 'DENIED'));
      await user.click(
        screen.getByRole('button', { name: 'Check stored command outcome' }),
      );
      await screen.findByText(/Stored human-command receipt found: denied/);
      expect(lookupCommand).toHaveBeenCalledExactlyOnceWith(held.key);
      expect(command).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
    },
  );
  it('account invalidation hides the private reference but matching reauthentication restores GET-only recovery', async () => {
    rows = [vera()];
    const held = { identity: 'owner-a', key: 'broadcast-private-request' };
    rememberCommand(held);
    const raw = sessionStorage.getItem(commandJournalKey);
    await open('agents');
    await screen.findByText(held.key);
    expect(sessionChannel).not.toBeNull();
    act(() => sessionChannel!.onmessage!(new MessageEvent('message')));
    expect(screen.queryByText(held.key)).toBeNull();
    expect(screen.queryByText('Command outcome unconfirmed')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Original profile · Paused VERA',
      }),
    ).toBeNull();
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    const user = userEvent.setup();
    vi.mocked(read).mockRejectedValueOnce(new Error('READ_UNAVAILABLE'));
    await user.click(
      screen.getByRole('button', { name: 'Refresh authorized snapshot' }),
    );
    expect(screen.queryByText(held.key)).toBeNull();
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    vi.mocked(read).mockResolvedValueOnce(envelope(rows));
    await user.click(
      screen.getByRole('button', { name: 'Refresh authorized snapshot' }),
    );
    await screen.findByText(held.key);
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
    vi.mocked(lookupCommand).mockResolvedValue(receipt(held.key, 'DENIED'));
    await user.click(
      screen.getByRole('button', { name: 'Check stored command outcome' }),
    );
    await screen.findByText(/Stored human-command receipt found: denied/);
    expect(lookupCommand).toHaveBeenCalledExactlyOnceWith(held.key);
    expect(command).not.toHaveBeenCalled();
  });
  it('an applied create cannot navigate the previous account target after a deferred foreign-account refresh', async () => {
    await open('projects');
    let finish!: (value: ReturnType<typeof envelope>) => void;
    const refresh = new Promise<ReturnType<typeof envelope>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(command).mockImplementationOnce(async (value) => {
      vi.mocked(read).mockImplementationOnce(() => refresh);
      return receipt(value.idempotency_key);
    });
    const user = await projectDraft();
    await user.click(
      screen.getByRole('button', { name: 'Submit project request' }),
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(command).toHaveBeenCalledTimes(1);
    const next = envelope([]);
    await act(async () => {
      finish({
        ...next,
        session: { ...next.session!, identity: 'owner-b', tenant: 'b' },
      });
      await refresh;
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'New project',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(navigation.push).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
  });
  it('a deferred command cannot refresh or navigate after unmount; the next view recovers only through GET', async () => {
    const view = await open('projects');
    let finish!: (value: ReturnType<typeof receipt>) => void;
    const response = new Promise<ReturnType<typeof receipt>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(command).mockImplementationOnce(() => response);
    const user = await projectDraft();
    await user.click(
      screen.getByRole('button', { name: 'Submit project request' }),
    );
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const request = vi.mocked(command).mock.calls[0][0];
    const raw = sessionStorage.getItem(commandJournalKey);
    expect(raw).not.toBeNull();
    const reads = vi.mocked(read).mock.calls.length;
    view.unmount();
    await act(async () => {
      finish(receipt(request.idempotency_key));
      await response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(lookupCommand).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    await open('projects');
    await screen.findByText(request.idempotency_key);
    vi.mocked(lookupCommand).mockResolvedValue(
      receipt(request.idempotency_key),
    );
    await user.click(
      screen.getByRole('button', { name: 'Check stored command outcome' }),
    );
    await screen.findByText(/Stored human-command receipt found: applied/);
    expect(lookupCommand).toHaveBeenCalledExactlyOnceWith(
      request.idempotency_key,
    );
    expect(command).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
  });
  it('a deferred command from a previous resource cannot replace the new resource or discard its recovery hold', async () => {
    const view = await open('projects');
    let finish!: (value: ReturnType<typeof receipt>) => void;
    const response = new Promise<ReturnType<typeof receipt>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(command).mockImplementationOnce(() => response);
    const user = await projectDraft();
    await user.click(
      screen.getByRole('button', { name: 'Submit project request' }),
    );
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const request = vi.mocked(command).mock.calls[0][0];
    const raw = sessionStorage.getItem(commandJournalKey);
    view.rerender(<ConsoleApp section="agents" mode="LOCAL_FIXTURE" />);
    await screen.findByRole('heading', { name: 'Agents / VERA' });
    await waitFor(() =>
      expect(vi.mocked(read).mock.calls.at(-1)?.[0]).toBe('agents'),
    );
    const reads = vi.mocked(read).mock.calls.length;
    await act(async () => {
      finish(receipt(request.idempotency_key));
      await response;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(vi.mocked(read).mock.calls.at(-1)?.[0]).toBe('agents');
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    await screen.findByText(request.idempotency_key);
    vi.mocked(lookupCommand).mockResolvedValue(
      receipt(request.idempotency_key, 'DENIED'),
    );
    await user.click(
      screen.getByRole('button', { name: 'Check stored command outcome' }),
    );
    await screen.findByText(/Stored human-command receipt found: denied/);
    expect(lookupCommand).toHaveBeenCalledExactlyOnceWith(
      request.idempotency_key,
    );
    expect(command).toHaveBeenCalledTimes(1);
    expect(vi.mocked(read).mock.calls.at(-1)?.[0]).toBe('agents');
  });
});

describe('integrated read-only Work relationships', () => {
  it('does not carry a failed Focus diagnostic into the pending first Work read', async () => {
    rows = [work()];
    vi.mocked(read).mockRejectedValueOnce(new Error('READ_UNAVAILABLE'));
    render(<ConsoleApp section="work" mode="LOCAL_FIXTURE" />);
    await screen.findByText(
      'Records unavailable. This is not an empty or all-clear result.',
    );
    let finish!: (value: ReturnType<typeof envelope>) => void;
    const response = new Promise<ReturnType<typeof envelope>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(read).mockImplementationOnce(() => response);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'All work' }));
    await user.click(screen.getByRole('button', { name: 'Map' }));
    expect(
      screen.getByText(/Waiting for an accepted tenant-scoped Work snapshot/),
    ).toBeTruthy();
    expect(screen.queryByText(/Work read unavailable/)).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    expect(
      screen.queryByText(/No task records in this authorized view/),
    ).toBeNull();
    await act(async () => {
      finish(envelope(rows));
      await response;
    });
    await screen.findByRole('article', { name: 'Task task-a' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
  });

  it('does not carry a previous Work-query failure into a pending different query', async () => {
    rows = [work()];
    const view = await open('work');
    await enterWorkMap();
    vi.mocked(read).mockRejectedValueOnce(new Error('READ_UNAVAILABLE'));
    await pollAuthorizedPage();
    await screen.findByText(/Work read unavailable/);
    let finish!: (value: ReturnType<typeof envelope>) => void;
    const response = new Promise<ReturnType<typeof envelope>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(read).mockImplementationOnce(() => response);
    navigation.query = 'different query';
    view.rerender(<ConsoleApp section="work" mode="LOCAL_FIXTURE" />);
    await waitFor(() =>
      expect(read).toHaveBeenLastCalledWith('work', {
        q: 'different query',
      }),
    );
    expect(
      screen.getByText(/Waiting for an accepted tenant-scoped Work snapshot/),
    ).toBeTruthy();
    expect(screen.queryByText(/Work read unavailable/)).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    await act(async () => {
      finish(
        envelope([{ ...work(), id: 'task-b', title: 'Different query work' }]),
      );
      await response;
    });
    await screen.findByRole('article', { name: 'Task task-b' });
    expect(screen.queryByRole('article', { name: 'Task task-a' })).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it('preserves the same-Work failure diagnostic and retained facts until a retry has actually succeeded', async () => {
    rows = [work()];
    await open('work');
    const user = await enterWorkMap();
    vi.mocked(read).mockRejectedValueOnce(new Error('READ_UNAVAILABLE'));
    await pollAuthorizedPage();
    await screen.findByText(/Work read unavailable/);
    let finish!: (value: ReturnType<typeof envelope>) => void;
    const response = new Promise<ReturnType<typeof envelope>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(read).mockImplementationOnce(() => response);
    await user.click(
      screen.getByRole('button', { name: 'Refresh authorized snapshot' }),
    );
    expect(screen.getByText(/Work read unavailable/)).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Task task-a' })).toBeTruthy();
    expect(
      screen
        .getByRole('region', { name: 'Work relationships' })
        .getAttribute('aria-busy'),
    ).toBe('true');
    await act(async () => {
      finish(envelope(rows));
      await response;
    });
    await waitFor(() =>
      expect(screen.queryByText(/Work read unavailable/)).toBeNull(),
    );
    expect(screen.getByRole('article', { name: 'Task task-a' })).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
  });

  it('keeps Map and List inside All work, passes an accepted CSRF-free page, and performs no presentation-triggered reads or commands', async () => {
    rows = [work()];
    navigation.query = 'renewal & q';
    await open('work');
    expect(read).toHaveBeenCalledExactlyOnceWith('focus', {
      q: navigation.query,
    });
    expect(screen.queryByRole('button', { name: 'Map' })).toBeNull();
    const user = await enterWorkMap();
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.mocked(read).mock.calls.at(-1)).toEqual([
      'work',
      { q: navigation.query },
    ]);
    expect(screen.getByRole('article', { name: 'Task task-a' })).toBeTruthy();
    expect(
      screen.queryByText(/snapshot unavailable or unsupported/),
    ).toBeNull();
    expect(
      screen.getByRole('group', { name: 'All work presentation' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const journal = sessionStorage.getItem(commandJournalKey);
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(
      screen.queryByRole('heading', { name: 'Work relationships' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Existing work · Outcome uncertain' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Map' }));
    expect(screen.getByRole('article', { name: 'Task task-a' })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(commandJournalKey)).toBe(journal);
  });

  it('uses raw task references with the existing namespace selector and preserves filters; operation links stay native Evidence navigation', async () => {
    const task = work();
    rows = [
      {
        ...task,
        id: 'task:one',
        fields: {
          ...task.fields,
          dependencies: ['task:outside'],
          operations: [
            {
              id: 'op:a',
              state: 'UNKNOWN',
              digest: 'd'.repeat(64),
              known: true,
              verified: false,
              label: 'Outcome uncertain',
              verificationScope: null,
              canRetry: false,
            },
          ],
        },
      },
    ];
    navigation.query = 'renewal & q';
    await open('work');
    const user = await enterWorkMap();
    expect(
      screen
        .getByRole('link', { name: 'Inspect operation op:a' })
        .getAttribute('href'),
    ).toBe('/console/evidence?selected=operation%3Aop%3Aa');
    expect(
      screen.getByText(/Referenced task not loaded; status UNKNOWN/),
    ).toBeTruthy();
    await user.click(
      screen.getByRole('button', {
        name: 'Existing work · Inspect task task:one',
      }),
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      '/console/work?q=renewal+%26+q&selected=task%3Atask%3Aone',
      { scroll: false },
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Inspect dependency task task:outside',
      }),
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      '/console/work?q=renewal+%26+q&selected=task%3Atask%3Aoutside',
      { scroll: false },
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
  });

  it('derives the map from one accepted page rather than frozen list rows mixed with newer envelope metadata', async () => {
    rows = [work()];
    navigation.selected = 'task:task-a';
    await open('work');
    const user = await enterWorkMap();
    await screen.findByRole('article', { name: 'Task task-a' });
    rows = [{ ...work(), id: 'task-b', title: 'New accepted page work' }];
    await pollAuthorizedPage();
    await screen.findByRole('article', { name: 'Task task-b' });
    expect(screen.queryByRole('article', { name: 'Task task-a' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'List' }));
    const list = within(screen.getByRole('region', { name: 'Work records' }));
    expect(
      list.getByRole('button', { name: 'Existing work · Outcome uncertain' }),
    ).toBeTruthy();
    expect(
      list.queryByRole('button', {
        name: 'New accepted page work · Outcome uncertain',
      }),
    ).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it('replaces cursor pages instead of building a tenant graph, retaining partial and unknown-count labels', async () => {
    rows = [work()];
    await open('work');
    const first = {
      ...envelope(rows),
      total: null,
      completeness: 'partial' as const,
      cursor: 'next-visible',
    };
    vi.mocked(read).mockResolvedValueOnce(first);
    const user = await enterWorkMap();
    expect(screen.getByText(/Collection count unknown/)).toBeTruthy();
    expect(screen.getByText(/this map does not include them/)).toBeTruthy();
    rows = [{ ...work(), id: 'task-b', title: 'Next page only' }];
    vi.mocked(read).mockResolvedValueOnce({
      ...envelope(rows),
      total: null,
      completeness: 'partial' as const,
    });
    await user.click(
      screen.getByRole('button', { name: 'Next authorized page' }),
    );
    await screen.findByRole('article', { name: 'Task task-b' });
    expect(read).toHaveBeenLastCalledWith('work', { cursor: 'next-visible' });
    expect(screen.queryByRole('article', { name: 'Task task-a' })).toBeNull();
    expect(screen.getByText(/Collection count unknown/)).toBeTruthy();
    expect(
      screen.queryByText(/No task records in this authorized view/),
    ).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it('labels retained facts on an actual Work read failure without fabricating an empty or all-clear result', async () => {
    rows = [work()];
    await open('work');
    await enterWorkMap();
    vi.mocked(read).mockRejectedValueOnce(new Error('READ_UNAVAILABLE'));
    await pollAuthorizedPage();
    await screen.findByText(
      /Work read unavailable; any shown records are retained/,
    );
    expect(screen.getByRole('article', { name: 'Task task-a' })).toBeTruthy();
    expect(screen.getByText(/Retained page/)).toBeTruthy();
    expect(
      screen.queryByText(/No task records in this authorized view/),
    ).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it('does not misclassify an unresolved command lookup as a failed Work read', async () => {
    const held = { identity: 'owner-a', key: 'map-unconfirmed-key' };
    expect(rememberCommand(held)).toBe(true);
    rows = [work()];
    await open('work');
    const user = await enterWorkMap();
    const reads = vi.mocked(read).mock.calls.length;
    vi.mocked(lookupCommand).mockRejectedValueOnce(
      new Error('READ_UNAVAILABLE'),
    );
    await user.click(
      screen.getByRole('button', { name: 'Check stored command outcome' }),
    );
    await screen.findByText(/Stored outcome is still unconfirmed/);
    expect(screen.getByRole('article', { name: 'Task task-a' })).toBeTruthy();
    expect(screen.queryByText(/Work read unavailable/)).toBeNull();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(lookupCommand).toHaveBeenCalledExactlyOnceWith(held.key);
    expect(command).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(commandJournalKey)).toContain(held.key);
  });

  it('clears the map and visible private correlation on session invalidation, restoring only the newly accepted account page', async () => {
    const held = { identity: 'owner-a', key: 'map-private-key' };
    expect(rememberCommand(held)).toBe(true);
    rows = [work()];
    await open('work');
    const user = await enterWorkMap();
    const raw = sessionStorage.getItem(commandJournalKey);
    const reads = vi.mocked(read).mock.calls.length;
    await act(async () =>
      sessionChannel!.onmessage!(new MessageEvent('message')),
    );
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText(held.key)).toBeNull();
    expect(
      screen.getByText(/snapshot unavailable or unsupported/),
    ).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    identity = 'owner-b';
    rows = [{ ...work(), id: 'task-b', title: 'New account page' }];
    await user.click(
      screen.getByRole('button', { name: 'Refresh authorized snapshot' }),
    );
    await screen.findByRole('article', { name: 'Task task-b' });
    expect(screen.queryByRole('article', { name: 'Task task-a' })).toBeNull();
    expect(screen.queryByText(held.key)).toBeNull();
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
  });

  it('keeps command controls held when affirmative command metadata is absent while still allowing a read-only Work map', async () => {
    rows = [work()];
    vi.mocked(read).mockImplementation(async () => ({
      ...envelope(rows),
      features: {},
    }));
    await open('work');
    await enterWorkMap();
    expect(
      (screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole('article', { name: 'Task task-a' })).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    expect(lookupCommand).not.toHaveBeenCalled();
  });

  it('does not adopt the previous Focus envelope as a Work page while the first Work read is pending', async () => {
    rows = [
      {
        ...work(),
        kind: 'focus',
        id: 'focus-only',
        title: 'Attention group only',
      },
    ];
    await open('work');
    let finish!: (value: ReturnType<typeof envelope>) => void;
    const response = new Promise<ReturnType<typeof envelope>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(read).mockImplementationOnce(() => response);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'All work' }));
    await user.click(screen.getByRole('button', { name: 'Map' }));
    expect(screen.queryByRole('article')).toBeNull();
    expect(
      screen.getByText(/Waiting for an accepted tenant-scoped Work snapshot/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/No task records in this authorized view/),
    ).toBeNull();
    await act(async () => {
      finish(envelope([work()]));
      await response;
    });
    await screen.findByRole('article', { name: 'Task task-a' });
    expect(
      screen.queryByRole('article', { name: 'Task focus-only' }),
    ).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
  });
});
