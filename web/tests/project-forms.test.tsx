import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  CommandInputs,
  CommandSchema,
  EnvelopeSchema,
  type ConsoleItem,
  type HumanCommand,
} from '@continuum/contracts';
import {
  CreateProjectForm,
  LinkTaskProjectForm,
} from '../components/ProjectForms';
import { command, read, type ClientEnvelope } from '@/lib/api';

vi.mock('@/lib/api', () => ({ read: vi.fn(), command: vi.fn() }));
const key = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
function work(revision: unknown = 7): ConsoleItem {
  return {
    id: 'task-a',
    kind: 'task',
    title: 'Existing work',
    version: 41,
    status: 'Outcome uncertain',
    fields: {
      coordinationRevision: revision,
      accountableVERA: 'vera-a',
      originalPrincipal: 'vera-a',
      project: null,
      operations: [{ id: 'op-a', state: 'UNKNOWN', digest: 'd'.repeat(64) }],
      approval: { digest: 'e'.repeat(64), revision: 3, grantVersion: 4 },
      grant: { id: 'grant-a', version: 4, resource: 'exact-resource' },
    },
  };
}
function project(id = 'project-a', title = 'Server project A'): ConsoleItem {
  return {
    id,
    kind: 'project',
    title,
    version: 3,
    status: 'Read-only project registry',
    fields: { objective: 'Server-recorded objective', tasks: [] },
  };
}
function page(
  items = [project()],
  overrides: Partial<ClientEnvelope> = {},
): ClientEnvelope {
  return {
    schema_version: 1,
    server_time: '2026-10-14T00:00:00Z',
    observed_at: '2026-10-14T00:00:00Z',
    fresh_until: '2026-10-14T00:00:30Z',
    projection_version: 9,
    source_revision: 'unit-test-only',
    completeness: 'complete',
    cursor: null,
    total: items.length,
    items,
    features: {
      commands: {
        state: 'available',
        scope: 'LOCAL_FIXTURE',
        reason: 'Unit-only verified command availability',
      },
    },
    session: {
      identity: 'owner-a',
      tenant: 'server-tenant-a',
      principal: null,
      expires: Date.parse('2026-10-14T00:01:00Z'),
      fresh_mfa: true,
    },
    scope: 'LOCAL_FIXTURE',
    csrf: 'unit-test-marker',
    ...overrides,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fillProject(
  name = ' Project name ',
  objective = 'Keep the exact objective.',
) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
    target: { value: name },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Project objective' }), {
    target: { value: objective },
  });
}
function createForm() {
  return screen.getByRole('form', { name: 'Record a project' });
}
function linkForm() {
  return screen.getByRole('form', { name: 'Link existing work to a project' });
}
async function chooseProject(id = 'project-a') {
  await waitFor(() => {
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Project from server results',
        }) as HTMLSelectElement
      ).disabled,
    ).toBe(false);
  });
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Project from server results' }),
    { target: { value: id } },
  );
}

let parentContext: Readonly<ClientEnvelope>;
let parentDeadline: number;

beforeEach(() => {
  parentContext = freeze(page([work()]));
  parentDeadline = performance.now() + 30000;
  vi.mocked(read).mockReset().mockResolvedValue(page());
  vi.mocked(command).mockReset();
  vi.spyOn(crypto, 'randomUUID')
    .mockReturnValueOnce(key)
    .mockReturnValueOnce(target)
    .mockReturnValue(key);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('create project command handoff', () => {
  it('uses accessible bounded fields and emits one exact version-zero request', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    render(<CreateProjectForm canAct busy={false} onCommand={onCommand} />);
    fillProject();
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Project name',
        }) as HTMLInputElement
      ).maxLength,
    ).toBe(200);
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Project objective',
        }) as HTMLTextAreaElement
      ).maxLength,
    ).toBe(8000);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    fireEvent.submit(createForm());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const value = onCommand.mock.calls[0][0];
    expect(value).toEqual({
      schema_version: 1,
      idempotency_key: key,
      kind: 'create_project',
      target: 'project-' + target,
      expected_version: 0,
      input: { name: ' Project name ', objective: 'Keep the exact objective.' },
    });
    expect(CommandSchema.parse(value)).toEqual(value);
    expect(CommandInputs.create_project.parse(value.input)).toEqual(
      value.input,
    );
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/successfully|project created|durably applied/i),
    ).toBeNull();
  });

  it('retains the server’s maximum bounds and permits an empty objective', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    render(<CreateProjectForm canAct busy={false} onCommand={onCommand} />);
    fillProject('x'.repeat(200), 'x'.repeat(8000));
    fireEvent.submit(createForm());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0][0].input).toEqual({
      name: 'x'.repeat(200),
      objective: 'x'.repeat(8000),
    });
    await waitFor(() => {
      expect(
        (
          screen.getByRole('button', {
            name: 'Submit project request',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444');
    fillProject('Another project', '');
    fireEvent.submit(createForm());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand.mock.calls[1][0].input).toEqual({
      name: 'Another project',
      objective: '',
    });
    expect(onCommand.mock.calls[1][0].idempotency_key).toBe(
      '33333333-3333-4333-8333-333333333333',
    );
    expect(onCommand.mock.calls[1][0].target).toBe(
      'project-44444444-4444-4444-8444-444444444444',
    );
    expect(crypto.randomUUID).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['', ''],
    ['   ', ''],
    ['x'.repeat(201), ''],
    ['Name', 'x'.repeat(8001)],
  ])(
    'rejects malformed bounds without generating a command identity',
    async (name, objective) => {
      const onCommand = vi.fn();
      render(<CreateProjectForm canAct busy={false} onCommand={onCommand} />);
      fillProject(name, objective);
      fireEvent.submit(createForm()); // Also exercise the guard behind native validation.
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(onCommand).not.toHaveBeenCalled();
      expect(crypto.randomUUID).not.toHaveBeenCalled();
    },
  );

  it.each([
    { canAct: false, busy: false },
    { canAct: true, busy: true },
  ])(
    'cannot submit when eligibility is denied or the parent is busy: %j',
    (props) => {
      const onCommand = vi.fn();
      render(<CreateProjectForm {...props} onCommand={onCommand} />);
      fillProject();
      fireEvent.submit(createForm());
      expect(
        (
          screen.getByRole('button', {
            name: 'Submit project request',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(onCommand).not.toHaveBeenCalled();
      expect(crypto.randomUUID).not.toHaveBeenCalled();
    },
  );

  it('does not mint another identity or hand off twice while a submission is pending', async () => {
    const pending = deferred<void>();
    const onCommand = vi.fn(() => pending.promise);
    render(<CreateProjectForm canAct busy={false} onCommand={onCommand} />);
    fillProject();
    fireEvent.submit(createForm());
    fireEvent.submit(createForm());
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
    expect(createForm().getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.resolve());
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it.each(['DENIED', 'REQUEST_UNCONFIRMED'])(
    'leaves %s outcomes to the parent and never retries or asserts success',
    async (error) => {
      const onCommand = vi.fn().mockRejectedValue(new Error(error));
      const view = render(
        <CreateProjectForm canAct busy={false} onCommand={onCommand} />,
      );
      fillProject();
      fireEvent.submit(createForm());
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Check its command status',
      );
      view.rerender(
        <CreateProjectForm canAct busy={false} onCommand={onCommand} />,
      );
      expect(onCommand).toHaveBeenCalledTimes(1);
      expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
      expect(
        (
          screen.getByRole('textbox', {
            name: 'Project name',
          }) as HTMLInputElement
        ).value,
      ).toBe(' Project name ');
      expect(
        screen.queryByRole('button', { name: /retry|resend/i }),
      ).toBeNull();
      expect(
        screen.queryByText(/project created|durably applied|verified success/i),
      ).toBeNull();
      expect(command).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('existing work project association', () => {
  it.each([0, 7, Number.MAX_SAFE_INTEGER - 1])(
    'submits exactly the observed coordination revision %s, never task.version',
    async (revision) => {
      const item = freeze(work(revision));
      const original = JSON.stringify(item);
      const onCommand = vi.fn().mockResolvedValue(undefined);
      render(
        <LinkTaskProjectForm
          context={parentContext}
          contextDeadline={parentDeadline}
          item={item}
          canAct
          busy={false}
          onCommand={onCommand}
        />,
      );
      const snapshot = screen.getByRole('region', {
        name: 'Recorded work snapshot',
      }).textContent;
      await chooseProject();
      expect(read).toHaveBeenCalledExactlyOnceWith('projects');
      expect(onCommand).not.toHaveBeenCalled();
      fireEvent.submit(linkForm());
      await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
      expect(onCommand.mock.calls[0][0]).toEqual({
        schema_version: 1,
        idempotency_key: key,
        kind: 'link_task_project',
        target: item.id,
        expected_version: revision,
        input: { project: 'project-a' },
      });
      expect(onCommand.mock.calls[0][0].expected_version).not.toBe(
        item.version,
      );
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(item)).toBe(original);
      expect(
        screen.getByRole('region', { name: 'Recorded work snapshot' })
          .textContent,
      ).toBe(snapshot);
      expect(screen.getByText('UNKNOWN')).toBeTruthy();
      expect(screen.getByText('d'.repeat(64))).toBeTruthy();
      expect(screen.getByText('e'.repeat(64))).toBeTruthy();
      expect(command).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    null,
    '7',
    false,
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'disables association for a missing, non-numeric or non-incrementable revision (%s)',
    async (revision) => {
      const item = work();
      item.fields.coordinationRevision = revision;
      const onCommand = vi.fn();
      render(
        <LinkTaskProjectForm
          context={parentContext}
          contextDeadline={parentDeadline}
          item={item}
          canAct
          busy={false}
          onCommand={onCommand}
        />,
      );
      await screen.findByRole('option', { name: /Server project A/ });
      expect(
        (
          screen.getByRole('button', {
            name: 'Submit project link request',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fireEvent.submit(linkForm());
      expect(onCommand).not.toHaveBeenCalled();
      expect(crypto.randomUUID).not.toHaveBeenCalled();
      expect(
        screen.getByText(/task version is not a substitute/i),
      ).toBeTruthy();
    },
  );

  it('rejects non-work objects even when they carry a plausible revision', async () => {
    const item = { ...work(), kind: 'operation' };
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it.each([
    { canAct: false, busy: false },
    { canAct: true, busy: true },
  ])('respects parent denial/busy state for association: %j', async (props) => {
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        {...props}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    fireEvent.submit(linkForm());
    expect(
      (
        screen.getByRole('button', {
          name: 'Submit project link request',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('does not auto-select a project, fabricate an empty-registry choice or accept unseen IDs', async () => {
    const onCommand = vi.fn();
    const { container } = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    const select = screen.getByRole('combobox', {
      name: 'Project from server results',
    }) as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.submit(linkForm());
    const unseen = document.createElement('option');
    unseen.value = 'unseen-project';
    unseen.textContent = 'Not returned by the API';
    select.append(unseen);
    fireEvent.change(select, { target: { value: unseen.value } });
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();

    vi.mocked(read).mockResolvedValueOnce(page([]));
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    expect(await screen.findByText('No projects on this page.')).toBeTruthy();
    expect(select.value).toBe('');
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('shows a 60-item partial first page and an unconsumed next-page cursor honestly', async () => {
    const projects = Array.from({ length: 60 }, (_, index) =>
      project('project-' + index, 'Project ' + index),
    );
    vi.mocked(read).mockResolvedValueOnce(
      page(projects, {
        completeness: 'partial',
        cursor: 'opaque-server-cursor',
        total: null,
      }),
    );
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    expect(await screen.findByText(/Partial project registry/)).toBeTruthy();
    expect(
      screen.getByText(/next page is available but is not loaded/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/60 project choices on this server-scoped first page/),
    ).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(61);
    expect(read).toHaveBeenCalledExactlyOnceWith('projects');
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('does not infer a next page from partial completeness alone', async () => {
    vi.mocked(read).mockResolvedValueOnce(
      page([project()], { completeness: 'partial', cursor: null, total: null }),
    );
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Partial project registry/)).toBeTruthy();
    expect(screen.queryByText(/next page is available/i)).toBeNull();
  });

  it('filters non-project and malformed IDs and renders server text without HTML execution', async () => {
    vi.mocked(read).mockResolvedValueOnce(
      page([
        project('project-a', '<img src=x onerror=alert(1)>'),
        project('invalid project id', 'Malformed ID'),
        { ...project('task-other', 'Not a project'), kind: 'task' },
      ]),
    );
    const { container } = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('option', { name: /<img src=x/ }),
    ).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(
      screen.queryByRole('option', { name: /Malformed ID|Not a project/ }),
    ).toBeNull();
  });

  it('clears the selected page during refresh and cannot submit a previous choice after read failure', async () => {
    const onCommand = vi.fn();
    vi.mocked(read).mockRejectedValueOnce(new Error('READ_UNAVAILABLE'));
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No selection is available',
    );
    expect(read).toHaveBeenCalledExactlyOnceWith('projects');
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();

    vi.mocked(read).mockResolvedValueOnce(page());
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    await chooseProject();
    const next = deferred<ClientEnvelope>();
    vi.mocked(read).mockReturnValueOnce(next.promise);
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    await act(async () => next.reject(new Error('STALE_SNAPSHOT')));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No selection is available',
    );
    expect(
      screen.queryByRole('option', { name: /Server project A/ }),
    ).toBeNull();
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('ignores an old work snapshot’s late read response', async () => {
    const old = deferred<ClientEnvelope>();
    vi.mocked(read)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page([project('project-b', 'Project B')]));
    const onCommand = vi.fn();
    const view = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    const other = { ...work(8), id: 'task-b', title: 'Other work' };
    view.rerender(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={other}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    expect(
      await screen.findByRole('option', { name: /Project B/ }),
    ).toBeTruthy();
    await act(async () => old.resolve(page()));
    expect(
      screen.queryByRole('option', { name: /Server project A/ }),
    ).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('never emits commands on reads, renders or theme changes and exposes no effect-authority controls', async () => {
    const item = freeze(work());
    const onCommand = vi.fn();
    const view = render(
      <div data-appearance="graphite">
        <CreateProjectForm canAct busy={false} onCommand={onCommand} />
        <LinkTaskProjectForm
          context={parentContext}
          contextDeadline={parentDeadline}
          item={item}
          canAct
          busy={false}
          onCommand={onCommand}
        />
      </div>,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    view.rerender(
      <div data-appearance="paper">
        <CreateProjectForm canAct busy={false} onCommand={onCommand} />
        <LinkTaskProjectForm
          context={parentContext}
          contextDeadline={parentDeadline}
          item={item}
          canAct
          busy={false}
          onCommand={onCommand}
        />
      </div>,
    );
    expect(read).toHaveBeenCalledExactlyOnceWith('projects');
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', {
        name: /approve|grant|retry|resend|dispatch|renew|transfer|execute/i,
      }),
    ).toBeNull();
    expect(
      screen.queryByText(/project created|verified success|authority granted/i),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

function searchProjects(query: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), {
    target: { value: query },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search projects' }));
}
function linkButton() {
  return screen.getByRole('button', {
    name: 'Submit project link request',
  }) as HTMLButtonElement;
}
function scopedPage(
  items = [project()],
  overrides: Partial<ClientEnvelope> = {},
) {
  return page(items, {
    session: {
      identity: 'owner-a',
      tenant: 'server-tenant-a',
      principal: null,
      expires: Date.parse('2026-10-14T00:01:00Z'),
      fresh_mfa: true,
    },
    ...overrides,
  });
}

describe('bound project drafts', () => {
  it('keeps the exact identity and payload for an unchanged submitted draft', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    render(<CreateProjectForm canAct busy={false} onCommand={onCommand} />);
    fillProject();
    fireEvent.submit(createForm());
    await waitFor(() =>
      expect(createForm().getAttribute('aria-busy')).toBe('false'),
    );
    const original = structuredClone(onCommand.mock.calls[0][0]);
    fireEvent.submit(createForm());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand.mock.calls[1][0]).toEqual(original);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['REQUEST_UNCONFIRMED', 'SESSION_EXPIRED', 'UNCLASSIFIED_FAILURE'])(
    'freezes the submitted draft after %s, including forced edits and eligibility rerenders',
    async (code) => {
      const onCommand = vi.fn().mockRejectedValue(new Error(code));
      const onClose = vi.fn();
      const view = render(
        <CreateProjectForm
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={onClose}
        />,
      );
      fillProject();
      fireEvent.submit(createForm());
      await screen.findByRole('alert');
      const original = structuredClone(onCommand.mock.calls[0][0]);
      view.rerender(
        <CreateProjectForm
          canAct={false}
          busy
          onCommand={onCommand}
          onClose={onClose}
        />,
      );
      view.rerender(
        <CreateProjectForm
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={onClose}
        />,
      );
      fillProject('Different body', 'Different objective');
      fireEvent.submit(createForm());
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(
        (
          screen.getByRole('textbox', {
            name: 'Project name',
          }) as HTMLInputElement
        ).value,
      ).toBe(original.input.name);
      expect(
        (
          screen.getByRole('textbox', {
            name: 'Project objective',
          }) as HTMLTextAreaElement
        ).value,
      ).toBe(original.input.objective);
      expect(
        (
          screen.getByRole('button', {
            name: 'Submit project request',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(onCommand).toHaveBeenCalledExactlyOnceWith(original);
      expect(onClose).not.toHaveBeenCalled();
      expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
      expect(command).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: /retry|resend|lookup/i }),
      ).toBeNull();
      expect(
        screen.queryByText(
          /verified success|project created|authority granted/i,
        ),
      ).toBeNull();
    },
  );

  it('does not let a callback mutation alter the cached submission binding', async () => {
    const values: HumanCommand[] = [];
    const onCommand = vi.fn(async (value: HumanCommand) => {
      values.push(structuredClone(value));
      value.idempotency_key = 'callback-mutated-key';
      value.target = 'callback-mutated-target';
      value.input.name = 'callback-mutated-name';
    });
    render(<CreateProjectForm canAct busy={false} onCommand={onCommand} />);
    fillProject();
    fireEvent.submit(createForm());
    await waitFor(() =>
      expect(createForm().getAttribute('aria-busy')).toBe('false'),
    );
    fireEvent.submit(createForm());
    await waitFor(() => expect(values).toHaveLength(2));
    expect(values[1]).toEqual(values[0]);
    expect(values[1].input.name).toBe(' Project name ');
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
  });
});

describe('server project search and pages', () => {
  it('selects a second-page project with the exact server query and cursor, deduplicating IDs', async () => {
    const query = ' Exact search %_ ';
    const projects = Array.from({ length: 60 }, (_, index) =>
      project('project-' + index, 'Match ' + index),
    );
    vi.mocked(read)
      .mockResolvedValueOnce(
        page([project('old', 'Old query')], { cursor: 'old-cursor' }),
      )
      .mockResolvedValueOnce(
        page(projects, {
          cursor: 'query-cursor',
          completeness: 'partial',
          total: 60,
        }),
      )
      .mockResolvedValueOnce(
        page([project('project-0'), project('project-60', 'Second page')], {
          total: 2,
        }),
      );
    const item = freeze(work(7));
    const original = JSON.stringify(item);
    const onCommand = vi.fn().mockResolvedValue(undefined);
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Old query/ });
    searchProjects(query);
    await screen.findByRole('option', { name: /Match 59/ });
    expect(screen.queryByRole('option', { name: /Old query/ })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more project choices' }),
    );
    await screen.findByRole('option', { name: /Second page/ });
    expect(screen.getAllByRole('option')).toHaveLength(62);
    expect(screen.getByText(/61 unique project choices loaded/)).toBeTruthy();
    expect(
      screen.getByText(/Latest server response reports total: 2/),
    ).toBeTruthy();
    expect(read).toHaveBeenNthCalledWith(2, 'projects', { q: query });
    expect(read).toHaveBeenNthCalledWith(3, 'projects', {
      q: query,
      cursor: 'query-cursor',
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(linkButton().disabled).toBe(true);
    await chooseProject('project-60');
    fireEvent.submit(linkForm());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0][0]).toEqual({
      schema_version: 1,
      idempotency_key: key,
      kind: 'link_task_project',
      target: item.id,
      expected_version: 7,
      input: { project: 'project-60' },
    });
    expect(JSON.stringify(item)).toBe(original);
    expect(command).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the exact 128-character query bound and Enter never submits a link', async () => {
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    const input = screen.getByRole('searchbox', {
      name: 'Search projects',
    }) as HTMLInputElement;
    expect(input.maxLength).toBe(128);
    searchProjects('q'.repeat(128));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith('projects', { q: 'q'.repeat(128) });
    await screen.findByRole('option', { name: /Server project A/ });
    fireEvent.change(input, { target: { value: 'q'.repeat(129) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Search projects' }));
    fireEvent.submit(linkForm());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(read).toHaveBeenCalledTimes(2);
    expect(linkButton().disabled).toBe(true);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('invalidates the selected rows and cursor on query edit before any new server request', async () => {
    vi.mocked(read).mockResolvedValueOnce(
      page([project()], { cursor: 'old-query-cursor' }),
    );
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await chooseProject();
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search projects' }),
      { target: { value: 'new query' } },
    );
    fireEvent.submit(linkForm());
    expect(linkButton().disabled).toBe(true);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(
      screen.queryByRole('option', { name: /Server project A/ }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Load more project choices' }),
    ).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith('projects');
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('allows only one page request at a time and holds selection while it is pending', async () => {
    const next = deferred<ClientEnvelope>();
    vi.mocked(read)
      .mockResolvedValueOnce(page([project()], { cursor: 'next-page' }))
      .mockReturnValueOnce(next.promise);
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await chooseProject();
    const more = screen.getByRole('button', {
      name: 'Load more project choices',
    });
    fireEvent.click(more);
    fireEvent.click(more);
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    fireEvent.submit(linkForm());
    expect(read).toHaveBeenCalledTimes(2);
    expect(linkButton().disabled).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
    await act(async () => next.resolve(page([project('project-b', 'Page B')])));
    await screen.findByRole('option', { name: /Page B/ });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(linkButton().disabled).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a superseded query’s late %s response',
    async (outcome) => {
      const old = deferred<ClientEnvelope>();
      vi.mocked(read)
        .mockResolvedValueOnce(page())
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(page([project('current', 'Current query')]));
      const onCommand = vi.fn();
      render(
        <LinkTaskProjectForm
          context={parentContext}
          contextDeadline={parentDeadline}
          item={work()}
          canAct
          busy={false}
          onCommand={onCommand}
        />,
      );
      await screen.findByRole('option', { name: /Server project A/ });
      searchProjects('older');
      searchProjects('current');
      await screen.findByRole('option', { name: /Current query/ });
      await act(async () => {
        if (outcome === 'resolve')
          old.resolve(page([project('private-old', 'Discarded private row')]));
        else old.reject(new Error('SESSION_EXPIRED'));
      });
      expect(
        screen.queryByRole('option', { name: /Discarded|Server project A/ }),
      ).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(read).toHaveBeenLastCalledWith('projects', { q: 'current' });
      expect(onCommand).not.toHaveBeenCalled();
      expect(crypto.randomUUID).not.toHaveBeenCalled();
    },
  );

  it('invalidates in-flight reads across eligibility changes and requires a fresh explicit choice', async () => {
    const old = deferred<ClientEnvelope>();
    const denied = deferred<ClientEnvelope>();
    vi.mocked(read)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(denied.promise)
      .mockResolvedValueOnce(page([project('current', 'Revalidated choice')]));
    const item = work();
    const onCommand = vi.fn();
    const view = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    view.rerender(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct={false}
        busy={false}
        onCommand={onCommand}
      />,
    );
    fireEvent.submit(linkForm());
    view.rerender(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Revalidated choice/ });
    await act(async () => {
      old.resolve(page([project('old', 'Old eligibility')]));
      denied.reject(new Error('READ_UNAVAILABLE'));
    });
    expect(
      screen.queryByRole('option', { name: /Old eligibility/ }),
    ).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(linkButton().disabled).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('deduplicates within and across pages without making null total a complete-registry claim', async () => {
    vi.mocked(read)
      .mockResolvedValueOnce(
        page([project(), project()], {
          cursor: 'dedupe',
          total: null,
          completeness: 'partial',
        }),
      )
      .mockResolvedValueOnce(
        page([project(), project('project-b'), project('project-b')], {
          total: null,
          completeness: 'partial',
        }),
      );
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more project choices' }),
    );
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getByText(/2 unique project choices loaded/)).toBeTruthy();
    expect(screen.getByText(/Server-reported total unavailable/)).toBeTruthy();
    expect(screen.getByText(/Partial project registry/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Load more project choices' }),
    ).toBeNull();
    expect(linkButton().disabled).toBe(true);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it.each(['STALE_SNAPSHOT', 'SESSION_EXPIRED', 'READ_UNAVAILABLE'])(
    'clears and holds choices after cursor %s until an explicit same-query refresh',
    async (code) => {
      vi.mocked(read)
        .mockResolvedValueOnce(page())
        .mockResolvedValueOnce(
          page([project('filtered', 'Filtered choice')], {
            cursor: 'filtered-cursor',
          }),
        )
        .mockRejectedValueOnce(new Error(code))
        .mockResolvedValueOnce(
          page([project('refreshed', 'Refreshed choice')]),
        );
      const onCommand = vi.fn();
      const view = render(
        <LinkTaskProjectForm
          context={parentContext}
          contextDeadline={parentDeadline}
          item={work()}
          canAct
          busy={false}
          onCommand={onCommand}
        />,
      );
      await screen.findByRole('option', { name: /Server project A/ });
      searchProjects('bound query');
      await chooseProject('filtered');
      fireEvent.click(
        screen.getByRole('button', { name: 'Load more project choices' }),
      );
      expect((await screen.findByRole('alert')).textContent).toContain(code);
      expect(
        screen.queryByRole('option', { name: /Filtered choice/ }),
      ).toBeNull();
      if (code === 'SESSION_EXPIRED')
        expect(
          screen.queryByRole('region', { name: 'Recorded work snapshot' }),
        ).toBeNull();
      expect(linkButton().disabled).toBe(true);
      fireEvent.submit(linkForm());
      expect(read).toHaveBeenCalledTimes(3);
      expect(onCommand).not.toHaveBeenCalled();
      if (code === 'SESSION_EXPIRED') {
        expect(
          (
            screen.getByRole('button', {
              name: 'Refresh project choices',
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        view.rerender(
          <LinkTaskProjectForm
            item={work()}
            context={freeze(page([work()]))}
            contextDeadline={performance.now() + 30000}
            canAct
            busy={false}
            onCommand={onCommand}
          />,
        );
      }
      fireEvent.click(
        screen.getByRole('button', { name: 'Refresh project choices' }),
      );
      await screen.findByRole('option', { name: /Refreshed choice/ });
      expect(read).toHaveBeenLastCalledWith('projects', { q: 'bound query' });
      expect(read).toHaveBeenCalledTimes(4);
      expect(linkButton().disabled).toBe(true);
      expect(onCommand).not.toHaveBeenCalled();
      expect(crypto.randomUUID).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    'identity',
    'tenant',
    'csrf',
    'scope',
    'earlier snapshot',
    'later snapshot',
  ])('refuses to mix a cursor page with changed %s', async (change) => {
    const first = scopedPage([project()], { cursor: 'session-cursor' });
    const next = scopedPage([project('foreign', 'Must be discarded')]);
    if (change === 'identity') next.session!.identity = 'other-owner';
    if (change === 'tenant') next.session!.tenant = 'other-server-tenant';
    if (change === 'csrf') next.csrf = 'different-session-marker';
    if (change === 'scope') next.scope = 'HISTORICAL';
    if (change === 'earlier snapshot') next.projection_version--;
    if (change === 'later snapshot') next.projection_version++;
    vi.mocked(read).mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await chooseProject();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more project choices' }),
    );
    await screen.findByRole('alert');
    if (!change.includes('snapshot'))
      expect(
        screen.queryByRole('region', { name: 'Recorded work snapshot' }),
      ).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(linkButton().disabled).toBe(true);
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith('projects', {
      cursor: 'session-cursor',
    });
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it.each(['fresh MFA', 'command feature'])(
    'cannot submit when the new read denies %s despite old canAct',
    async (denial) => {
      const snapshot = scopedPage();
      if (denial === 'fresh MFA') snapshot.session!.fresh_mfa = false;
      else
        snapshot.features.commands = {
          state: 'requires_setup',
          scope: 'NONE',
          reason: 'Fresh MFA required',
        };
      vi.mocked(read).mockResolvedValueOnce(snapshot);
      const onCommand = vi.fn();
      render(
        <LinkTaskProjectForm
          context={parentContext}
          contextDeadline={parentDeadline}
          item={work()}
          canAct
          busy={false}
          onCommand={onCommand}
        />,
      );
      await screen.findByRole('alert');
      expect(screen.getAllByRole('option')).toHaveLength(1);
      expect(
        screen.queryByRole('region', { name: 'Recorded work snapshot' }),
      ).toBeNull();
      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'project-a' },
      });
      fireEvent.submit(linkForm());
      expect(linkButton().disabled).toBe(true);
      expect(onCommand).not.toHaveBeenCalled();
      expect(crypto.randomUUID).not.toHaveBeenCalled();
    },
  );

  it('refuses a repeated cursor without a silent broad fallback or more requests', async () => {
    vi.mocked(read)
      .mockResolvedValueOnce(page([project()], { cursor: 'same-cursor' }))
      .mockResolvedValueOnce(
        page([project('project-b')], { cursor: 'same-cursor' }),
      );
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more project choices' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'STALE_SNAPSHOT',
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(linkButton().disabled).toBe(true);
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('ignores unmounted responses and never hands off a command', async () => {
    const pending = deferred<ClientEnvelope>();
    vi.mocked(read).mockReturnValueOnce(pending.promise);
    const onCommand = vi.fn();
    const view = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    view.unmount();
    await act(async () =>
      pending.resolve(scopedPage([project('late', 'Late private choice')])),
    );
    expect(screen.queryByRole('option')).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('requires a fresh choice after the work revision changes and uses only the new coordination revision', async () => {
    vi.mocked(read)
      .mockResolvedValueOnce(page([project()], { cursor: 'old-work-cursor' }))
      .mockResolvedValueOnce(page());
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const item = work(7);
    const view = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await chooseProject();
    view.rerender(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work(8)}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    fireEvent.submit(linkForm());
    await screen.findByRole('option', { name: /Server project A/ });
    expect(linkButton().disabled).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Load more project choices' }),
    ).toBeNull();
    await chooseProject();
    fireEvent.submit(linkForm());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0][0].expected_version).toBe(8);
    expect(onCommand.mock.calls[0][0].expected_version).not.toBe(item.version);
  });

  it('refuses an expired snapshot before using its cursor or handing off a link', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    parentDeadline = 30000;
    vi.mocked(read).mockResolvedValue(
      page([project()], { cursor: 'expired-cursor' }),
    );
    const onCommand = vi.fn();
    const view = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await chooseProject();
    clock.mockReturnValue(30000);
    fireEvent.submit(linkForm());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'STALE_SNAPSHOT',
    );
    const renewed = page([project()], {
      cursor: 'expired-cursor',
      server_time: '2026-10-14T00:00:30Z',
      fresh_until: '2026-10-14T00:01:00Z',
      session: {
        ...page().session!,
        expires: Date.parse('2026-10-14T00:01:30Z'),
      },
    });
    vi.mocked(read).mockResolvedValue(renewed);
    view.rerender(
      <LinkTaskProjectForm
        item={work()}
        context={freeze({ ...renewed, items: [work()] })}
        contextDeadline={60000}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    await chooseProject();
    clock.mockReturnValue(60000);
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more project choices' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'STALE_SNAPSHOT',
    );
    expect(read).toHaveBeenCalledTimes(2); // Initial and parent-revalidated read only; no cursor fallback.
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('does not expose cached work facts after an expired read and waits for explicit refresh', async () => {
    vi.mocked(read)
      .mockRejectedValueOnce(new Error('SESSION_EXPIRED'))
      .mockResolvedValueOnce(page());
    const item = freeze(work());
    const original = JSON.stringify(item);
    const onCommand = vi.fn();
    const view = render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('region', { name: 'Recorded work snapshot' }),
    ).toBeNull();
    expect(screen.queryByText('d'.repeat(64))).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole('button', {
          name: 'Refresh project choices',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    view.rerender(
      <LinkTaskProjectForm
        item={item}
        context={freeze(page([item]))}
        contextDeadline={performance.now() + 30000}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    await screen.findByRole('option', { name: /Server project A/ });
    expect(
      screen.getByRole('region', { name: 'Recorded work snapshot' }),
    ).toBeTruthy();
    expect(JSON.stringify(item)).toBe(original);
    expect(linkButton().disabled).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('retains the exact link binding and freezes all edits after an unconfirmed handoff', async () => {
    vi.mocked(read).mockResolvedValueOnce(
      page([project(), project('project-b', 'Other choice')]),
    );
    const item = freeze(work());
    const original = JSON.stringify(item);
    const onCommand = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('REQUEST_UNCONFIRMED'));
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await chooseProject();
    fireEvent.submit(linkForm());
    await waitFor(() =>
      expect(linkForm().getAttribute('aria-busy')).toBe('false'),
    );
    const request = structuredClone(onCommand.mock.calls[0][0]);
    fireEvent.submit(linkForm());
    await screen.findByRole('alert');
    expect(onCommand.mock.calls[1][0]).toEqual(request);
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'project-b' },
    });
    searchProjects('Different search');
    fireEvent.submit(linkForm());
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
      'project-a',
    );
    expect(onCommand).toHaveBeenCalledTimes(2);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(item)).toBe(original);
  });

  it('respects explicit work eligibility denial without changing the recorded task or approvals', async () => {
    const item = freeze({
      ...work(),
      eligibility: { allowed: false, reason: 'No current command eligibility' },
    });
    const original = JSON.stringify(item);
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'project-a' },
    });
    fireEvent.submit(linkForm());
    expect(linkButton().disabled).toBe(true);
    expect(
      screen.getByText(/current server read does not allow commands/i),
    ).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(JSON.stringify(item)).toBe(original);
  });

  it('does not revive a refused session by editing the query without a verified read', async () => {
    const first = scopedPage([project()], { cursor: 'account-cursor' });
    const changed = scopedPage([project('other', 'Other account project')]);
    changed.session!.identity = 'other-owner';
    vi.mocked(read).mockResolvedValueOnce(first).mockResolvedValueOnce(changed);
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await chooseProject();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more project choices' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('region', { name: 'Recorded work snapshot' }),
    ).toBeNull();
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search projects' }),
      { target: { value: 'pending query' } },
    );
    expect(
      screen.queryByRole('region', { name: 'Recorded work snapshot' }),
    ).toBeNull();
    expect(screen.queryByText('d'.repeat(64))).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('refuses projection regression across a new query instead of replacing a newer snapshot', async () => {
    vi.mocked(read)
      .mockResolvedValueOnce(scopedPage())
      .mockResolvedValueOnce(
        scopedPage([project('older', 'Older snapshot')], {
          projection_version: 8,
        }),
      );
    const onCommand = vi.fn();
    render(
      <LinkTaskProjectForm
        context={parentContext}
        contextDeadline={parentDeadline}
        item={work()}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    searchProjects('new query');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'STALE_SNAPSHOT',
    );
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(read).toHaveBeenLastCalledWith('projects', { q: 'new query' });
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });
});

// The selected work/detail supplies this context. A collection response may
// confirm it, but cannot supply the initial work authority itself.
type ContextFormProps = React.ComponentProps<typeof LinkTaskProjectForm> & {
  context?: Readonly<ClientEnvelope>;
  contextDeadline?: number;
};
function renderContextLink(
  onCommand = vi.fn(),
  overrides: Partial<ContextFormProps> = {},
) {
  return render(
    <LinkTaskProjectForm
      item={work()}
      canAct
      busy={false}
      onCommand={onCommand}
      context={parentContext}
      contextDeadline={parentDeadline}
      {...overrides}
    />,
  );
}
function expectPrivateContextHeld(onCommand: ReturnType<typeof vi.fn>) {
  expect(
    screen.queryByRole('region', { name: 'Recorded work snapshot' }),
  ).toBeNull();
  expect(screen.queryByText('d'.repeat(64))).toBeNull();
  expect(screen.queryByText('e'.repeat(64))).toBeNull();
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(
    true,
  );
  expect(linkButton().disabled).toBe(true);
  fireEvent.submit(linkForm());
  expect(onCommand).not.toHaveBeenCalled();
  expect(crypto.randomUUID).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}
const untrustedMetadata: Array<[string, (value: ClientEnvelope) => void]> = [
  [
    'missing session',
    (value) => {
      value.session = undefined;
    },
  ],
  [
    'missing identity',
    (value) => {
      Object.assign(value.session!, { identity: undefined });
    },
  ],
  [
    'empty identity',
    (value) => {
      value.session!.identity = '';
    },
  ],
  [
    'over-bound opaque identity',
    (value) => {
      value.session!.identity = 'x'.repeat(4097);
    },
  ],
  [
    'empty tenant',
    (value) => {
      value.session!.tenant = '';
    },
  ],
  [
    'missing principal',
    (value) => {
      Object.assign(value.session!, { principal: undefined });
    },
  ],
  [
    'missing fresh MFA',
    (value) => {
      Object.assign(value.session!, { fresh_mfa: undefined });
    },
  ],
  [
    'denied fresh MFA',
    (value) => {
      value.session!.fresh_mfa = false;
    },
  ],
  [
    'missing command feature',
    (value) => {
      value.features = {};
    },
  ],
  [
    'unavailable command feature',
    (value) => {
      value.features.commands.state = 'temporarily_unavailable';
    },
  ],
  [
    'expired session',
    (value) => {
      value.session!.expires = Date.parse(value.server_time);
    },
  ],
  [
    'nonfinite session expiry',
    (value) => {
      value.session!.expires = Infinity;
    },
  ],
  [
    'zero freshness lifetime',
    (value) => {
      value.fresh_until = value.server_time;
    },
  ],
  [
    'nonfinite freshness lifetime',
    (value) => {
      value.fresh_until = 'not-a-timestamp';
    },
  ],
];

describe('first project response trusted context', () => {
  it.each([
    'identity',
    'tenant',
    'principal',
    'scope',
    'csrf',
    'source revision',
  ])(
    'refuses a schema-valid foreign FIRST page with changed %s',
    async (change) => {
      const foreign = page([
        project('foreign-first', 'Foreign first private project'),
      ]);
      if (change === 'identity') foreign.session!.identity = 'owner-b';
      if (change === 'tenant') foreign.session!.tenant = 'server-tenant-b';
      if (change === 'principal') foreign.session!.principal = 'principal-b';
      if (change === 'scope') {
        foreign.scope = 'STAGING';
        foreign.features.commands.scope = 'STAGING';
      }
      if (change === 'csrf') foreign.csrf = 'other-session-marker';
      if (change === 'source revision')
        foreign.source_revision = 'other-server-source';
      const { csrf, ...wire } = foreign;
      expect(EnvelopeSchema.safeParse(wire).success).toBe(true);
      expect(csrf).toBeTruthy();
      vi.mocked(read).mockResolvedValueOnce(foreign);
      const item = freeze(work());
      const original = JSON.stringify(item);
      const onCommand = vi.fn();
      renderContextLink(onCommand, { item });
      await act(async () => undefined);
      expectPrivateContextHeld(onCommand);
      expect(screen.queryByText(/Foreign first private project/)).toBeNull();
      expect(read).toHaveBeenCalledExactlyOnceWith('projects');
      fireEvent.click(
        screen.getByRole('button', { name: 'Refresh project choices' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Search projects' }));
      expect(read).toHaveBeenCalledTimes(1); // Revalidate the parent, not a catalog retry.
      expect(JSON.stringify(item)).toBe(original);
    },
  );

  it.each(['context', 'deadline'])(
    'holds without a supplied parent %s and never adopts the first page',
    async (missing) => {
      const onCommand = vi.fn();
      renderContextLink(
        onCommand,
        missing === 'context'
          ? { context: undefined }
          : { contextDeadline: undefined },
      );
      await act(async () => undefined);
      expectPrivateContextHeld(onCommand);
      expect(read).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole('button', { name: 'Refresh project choices' }),
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([NaN, Infinity, -1])(
    'holds an invalid parent deadline %s',
    async (deadline) => {
      const onCommand = vi.fn();
      renderContextLink(onCommand, { contextDeadline: deadline });
      await act(async () => undefined);
      expectPrivateContextHeld(onCommand);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(untrustedMetadata)(
    'holds an invalid parent: %s',
    async (_name, change) => {
      const context = page([work()]);
      change(context);
      const onCommand = vi.fn();
      renderContextLink(onCommand, { context: freeze(context) });
      await act(async () => undefined);
      expectPrivateContextHeld(onCommand);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(untrustedMetadata)(
    'refuses insufficient FIRST-page metadata: %s',
    async (_name, change) => {
      const response = page();
      change(response);
      vi.mocked(read).mockResolvedValueOnce(response);
      const onCommand = vi.fn();
      renderContextLink(onCommand);
      await act(async () => undefined);
      expectPrivateContextHeld(onCommand);
      expect(read).toHaveBeenCalledExactlyOnceWith('projects');
      fireEvent.click(
        screen.getByRole('button', { name: 'Refresh project choices' }),
      );
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses a first projection below the selected detail floor', async () => {
    vi.mocked(read).mockResolvedValueOnce(
      page([project('old', 'Old private project')], {
        projection_version: parentContext.projection_version - 1,
      }),
    );
    const onCommand = vi.fn();
    renderContextLink(onCommand);
    await act(async () => undefined);
    expectPrivateContextHeld(onCommand);
    expect(screen.getByRole('alert').textContent).toContain('STALE_SNAPSHOT');
    expect(read).toHaveBeenCalledExactlyOnceWith('projects');
  });

  it.each([null, 'principal-a'])(
    'accepts the exact opaque parent identity and nullable principal %s',
    async (principal) => {
      const response = page();
      response.session!.identity = 'opaque issuer|subject @ /identity';
      response.session!.principal = principal;
      const context = freeze({ ...response, items: [work()] });
      vi.mocked(read).mockResolvedValueOnce(response);
      const onCommand = vi.fn().mockResolvedValue(undefined);
      renderContextLink(onCommand, { context });
      await chooseProject();
      fireEvent.submit(linkForm());
      await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
      expect(onCommand.mock.calls[0][0]).toMatchObject({
        kind: 'link_task_project',
        target: 'task-a',
        expected_version: 7,
        input: { project: 'project-a' },
      });
      expect(read).toHaveBeenCalledExactlyOnceWith('projects');
      expect(command).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('discards a pending old first response when the selected detail context changes', async () => {
    const pending = deferred<ClientEnvelope>();
    const newItem = freeze({
      ...work(8),
      id: 'task-b',
      title: 'New verified work',
    });
    const response = page(
      [project('project-b', 'Verified account B project')],
      {
        projection_version: 12,
        source_revision: 'new-detail-source',
        csrf: 'new-parent-marker',
        session: {
          ...page().session!,
          identity: 'owner-b',
          tenant: 'server-tenant-b',
        },
      },
    );
    const context = freeze({ ...response, items: [newItem] });
    vi.mocked(read)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response);
    const onCommand = vi.fn();
    const view = renderContextLink(onCommand);
    view.rerender(
      <LinkTaskProjectForm
        item={newItem}
        context={context}
        contextDeadline={parentDeadline}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Verified account B project/ });
    await act(async () =>
      pending.resolve(
        page([project('late-a', 'Late private account A project')]),
      ),
    );
    expect(
      screen.queryByRole('option', { name: /Late private account A/ }),
    ).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Recorded work snapshot' })
        .textContent,
    ).toContain('New verified work');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('discards a pending response when only the parent deadline changes', async () => {
    const old = deferred<ClientEnvelope>();
    vi.mocked(read)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page([project('new-page', 'New deadline page')]));
    const onCommand = vi.fn();
    const item = work();
    const view = renderContextLink(onCommand, { item });
    view.rerender(
      <LinkTaskProjectForm
        item={item}
        context={parentContext}
        contextDeadline={parentDeadline - 1}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /New deadline page/ });
    await act(async () =>
      old.resolve(page([project('old-page', 'Old deadline page')])),
    );
    expect(
      screen.queryByRole('option', { name: /Old deadline page/ }),
    ).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(linkButton().disabled).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('clears a pending read immediately when the parent context loses affirmative metadata', async () => {
    const pending = deferred<ClientEnvelope>();
    vi.mocked(read).mockReturnValueOnce(pending.promise);
    const onCommand = vi.fn();
    const item = work();
    const view = renderContextLink(onCommand, { item });
    const invalid = freeze(page([item], { features: {} }));
    view.rerender(
      <LinkTaskProjectForm
        item={item}
        context={invalid}
        contextDeadline={parentDeadline}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    expectPrivateContextHeld(onCommand);
    await act(async () => pending.resolve(page()));
    expectPrivateContextHeld(onCommand);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('clears an explicit choice on a context change before permitting a new verified choice', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const item = work();
    const view = renderContextLink(onCommand, { item });
    await chooseProject();
    const next = freeze(page([item]));
    view.rerender(
      <LinkTaskProjectForm
        item={item}
        context={next}
        contextDeadline={parentDeadline}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    fireEvent.submit(linkForm());
    expect(onCommand).not.toHaveBeenCalled();
    await screen.findByRole('option', { name: /Server project A/ });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(linkButton().disabled).toBe(true);
    await chooseProject();
    fireEvent.submit(linkForm());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not revive a refused first response until a new verified parent context arrives', async () => {
    const foreign = page();
    foreign.session!.identity = 'foreign-owner';
    vi.mocked(read)
      .mockResolvedValueOnce(foreign)
      .mockResolvedValueOnce(page());
    const onCommand = vi.fn();
    const item = work();
    const view = renderContextLink(onCommand, { item });
    await act(async () => undefined);
    expectPrivateContextHeld(onCommand);
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    expect(read).toHaveBeenCalledTimes(1);
    const verified = freeze(page([item]));
    view.rerender(
      <LinkTaskProjectForm
        item={item}
        context={verified}
        contextDeadline={parentDeadline}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Server project A/ });
    expect(
      screen.getByRole('region', { name: 'Recorded work snapshot' }),
    ).toBeTruthy();
    expect(linkButton().disabled).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('expires the page at the parent monotonic deadline even if the catalog is fresh', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const onCommand = vi.fn();
    renderContextLink(onCommand, { contextDeadline: 100 });
    await chooseProject();
    clock.mockReturnValue(100);
    fireEvent.submit(linkForm());
    await act(async () => undefined);
    expectPrivateContextHeld(onCommand);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('accounts for response latency from request start instead of renewing an old page on receipt', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const pending = deferred<ClientEnvelope>();
    vi.mocked(read).mockReturnValueOnce(pending.promise);
    const onCommand = vi.fn();
    renderContextLink(onCommand, { contextDeadline: 30000 });
    clock.mockReturnValue(2000);
    await act(async () =>
      pending.resolve(
        page([project('slow', 'Expired in transit')], {
          fresh_until: '2026-10-14T00:00:01Z',
        }),
      ),
    );
    expectPrivateContextHeld(onCommand);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('private picker context fencing', () => {
  it('does not carry private search text into a different verified parent account', async () => {
    const item = work();
    const nextItem = freeze({
      ...work(),
      id: 'task-b',
      title: 'Verified account B work',
    });
    const accountB = page([project('project-b', 'Verified account B choice')], {
      csrf: 'account-b-marker',
      session: { ...page().session!, identity: 'owner-b', tenant: 'tenant-b' },
    });
    const contextB = freeze({ ...accountB, items: [nextItem] });
    vi.mocked(read)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(accountB);
    const onCommand = vi.fn();
    const view = renderContextLink(onCommand, { item });
    await screen.findByRole('option', { name: /Server project A/ });
    searchProjects('private account A filter');
    await chooseProject();
    view.rerender(
      <LinkTaskProjectForm
        item={nextItem}
        context={contextB}
        contextDeadline={parentDeadline}
        canAct
        busy={false}
        onCommand={onCommand}
      />,
    );
    await screen.findByRole('option', { name: /Verified account B choice/ });
    expect(read).toHaveBeenLastCalledWith('projects');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByText(/private account A filter/)).toBeNull();
    fireEvent.submit(linkForm());
    expect(linkButton().disabled).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onCommand).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('conceals private search text when a foreign response holds parent reauthentication', async () => {
    const foreign = page([project('foreign', 'Foreign private project')]);
    foreign.session!.identity = 'other-owner';
    vi.mocked(read)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(foreign);
    const onCommand = vi.fn();
    renderContextLink(onCommand);
    await screen.findByRole('option', { name: /Server project A/ });
    searchProjects('private account A filter');
    await screen.findByRole('alert');
    expectPrivateContextHeld(onCommand);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('searchbox') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh project choices' }),
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
});
