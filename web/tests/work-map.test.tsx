import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  EnvelopeSchema,
  type ConsoleItem,
  type ReadEnvelope,
} from '@continuum/contracts';
import {
  WorkMap,
  deriveWorkMap,
  type WorkMapProps,
} from '../components/WorkMap';

function op(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-a',
    state: 'UNKNOWN',
    digest: 'd'.repeat(64),
    known: true,
    verified: false,
    label: 'Outcome uncertain',
    verificationScope: null,
    canRetry: false,
    ...overrides,
  };
}
function work(
  id = 'task-a',
  fields: Record<string, unknown> = {},
  overrides: Partial<ConsoleItem> = {},
): ConsoleItem {
  return {
    id,
    kind: 'task',
    title: 'Recorded objective ' + id,
    version: 7,
    status: 'Planned — no workflow admitted',
    fields: {
      accountableVERA: 'vera-accountable',
      originalPrincipal: 'vera-original',
      project: null,
      waitingOn: null,
      coordinationRevision: 2,
      dependencies: [],
      operations: [],
      ...fields,
    },
    ...overrides,
  };
}
function page(
  items: ConsoleItem[] = [work()],
  overrides: Partial<ReadEnvelope> = {},
): ReadEnvelope {
  return {
    schema_version: 1,
    server_time: '2026-10-14T00:00:00.000Z',
    observed_at: '2026-10-14T00:00:00.000Z',
    fresh_until: '2026-10-14T00:00:30.000Z',
    projection_version: 17,
    source_revision: 'unit-test-only',
    completeness: 'complete',
    cursor: null,
    total: items.length,
    items,
    features: {},
    scope: 'LOCAL_FIXTURE',
    session: {
      identity: 'human-a',
      tenant: 'tenant-a',
      principal: null,
      expires: Date.parse('2026-10-14T00:00:30.000Z'),
      fresh_mfa: false,
    },
    ...overrides,
  };
}
function props(overrides: Partial<WorkMapProps> = {}): WorkMapProps {
  return {
    envelope: page(),
    loading: false,
    stale: false,
    offline: false,
    readUnavailable: false,
    onInspectTask: vi.fn(),
    ...overrides,
  };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function taskArticle(id = 'task-a') {
  return screen.getByRole('article', { name: 'Task ' + id });
}
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(() => {
    throw Error('Work map must not issue a network request');
  });
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pure current-page Work relationships', () => {
  it('derives only explicit directed references and keeps task/operation namespaces separate', () => {
    const items = freeze([
      work('shared:id', {
        dependencies: ['task-b', 'outside', 'task-b'],
        operations: [op({ id: 'shared:id' })],
        waitingOn: 'A recorded waiting reason, not a dependency ID',
      }),
      work('task-b'),
    ]);
    const before = JSON.stringify(items);
    const result = deriveWorkMap(items);
    expect(result.tasks.map((item) => item.key)).toEqual([
      'task:shared:id',
      'task:task-b',
    ]);
    expect(result.tasks[0].dependencies).toEqual(['task-b', 'outside']);
    expect(result.tasks[1].dependencies).toEqual([]);
    expect(result.operations[0].key).toBe('operation:shared:id');
    expect(result.tasks[0].operations[0]).toEqual(result.operations[0]);
    expect(result.incomplete).toBe(false);
    expect(JSON.stringify(items)).toBe(before);
  });

  it('retains self references and cycles without traversal or invented execution order', () => {
    const result = deriveWorkMap(
      freeze([
        work('a', { dependencies: ['b', 'a'] }),
        work('b', { dependencies: ['a'] }),
      ]),
    );
    expect(result.tasks.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.tasks.map((item) => item.dependencies)).toEqual([
      ['b', 'a'],
      ['a'],
    ]);
    expect(result.incomplete).toBe(false);
  });

  it('deduplicates identical task/operation records without double-counting actual identities', () => {
    const first = work('task-a', { operations: [op(), op()] });
    const result = deriveWorkMap([
      first,
      first,
      work('task-b', { operations: [op()] }),
    ]);
    expect(result.tasks).toHaveLength(2);
    expect(result.operations).toHaveLength(1);
    expect(result.tasks.map((item) => item.operations.length)).toEqual([1, 1]);
    expect(result.incomplete).toBe(false);
  });

  it.each([
    ['objective', { title: 'Changed objective' }],
    ['phase', { status: 'Executing' }],
    ['revision', { version: 8 }],
    ['dependency', { fields: { ...work().fields, dependencies: ['b'] } }],
    [
      'accountability',
      { fields: { ...work().fields, accountableVERA: 'vera-b' } },
    ],
  ])(
    'makes conflicting %s task records unavailable instead of choosing first/last',
    (_label, changes) => {
      const original = work();
      const changed = { ...original, ...changes } as ConsoleItem;
      for (const items of [
        [original, changed, original],
        [changed, original],
      ]) {
        const result = deriveWorkMap(items);
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].conflict).toBe(true);
        expect(result.tasks[0].phase).toContain('UNKNOWN');
        expect(result.tasks[0].dependencies).toEqual([]);
        expect(result.tasks[0].operations).toEqual([]);
        expect(result.incomplete).toBe(true);
      }
    },
  );

  it.each([
    ['digest', op({ digest: 'e'.repeat(64) })],
    ['state', op({ state: 'REQUESTED', label: 'Pending' })],
    [
      'verification',
      op({
        state: 'COMMITTED',
        verified: true,
        label: 'Verified fixture result',
        verificationScope: 'LOCAL_FIXTURE',
      }),
    ],
  ])(
    'degrades conflicting shared operation %s metadata in every task reference',
    (_label, changed) => {
      const result = deriveWorkMap([
        work('a', { operations: [op()] }),
        work('b', { operations: [changed] }),
        work('c', { operations: [op()] }),
      ]);
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].conflict).toBe(true);
      for (const item of result.tasks) {
        expect(item.operations[0].state).toBeNull();
        expect(item.operations[0].verified).toBeNull();
        expect(item.operationsKnown).toBe(false);
      }
      expect(result.incomplete).toBe(true);
    },
  );

  it('detects conflicting duplicate operations inside a single record', () => {
    const result = deriveWorkMap([
      work('a', { operations: [op(), op({ digest: 'e'.repeat(64) })] }),
    ]);
    expect(result.tasks[0].operations).toHaveLength(1);
    expect(result.tasks[0].operations[0].conflict).toBe(true);
    expect(result.incomplete).toBe(true);
  });

  it.each(['', ' task-a', 'task-a\n', 'bad/id', '[Redacted]', 'a'.repeat(129)])(
    'does not materialize a task or link with invalid exact ID %j',
    (id) => {
      const result = deriveWorkMap([work(id)]);
      expect(result.tasks).toEqual([]);
      expect(result.incomplete).toBe(true);
      const refs = deriveWorkMap([
        work('good', { dependencies: [id], operations: [op({ id })] }),
      ]);
      expect(refs.tasks[0].dependencies).toEqual([]);
      expect(refs.operations).toEqual([]);
      expect(refs.incomplete).toBe(true);
    },
  );

  it('handles identifier-like prototype names with Maps rather than object-key aliases', () => {
    const result = deriveWorkMap([
      work('constructor', {
        dependencies: ['toString'],
        operations: [op({ id: 'constructor' })],
      }),
      work('toString'),
    ]);
    expect(result.tasks.map((item) => item.id)).toEqual([
      'constructor',
      'toString',
    ]);
    expect(result.operations[0].id).toBe('constructor');
    expect(result.incomplete).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['redacted', '[Redacted]'],
    ['object', { references: ['b'] }],
  ])(
    'keeps %s dependency/operation collections unknown, not empty',
    (_label, value) => {
      const result = deriveWorkMap([
        work('a', { dependencies: value, operations: value }),
      ]);
      expect(result.tasks[0].dependenciesKnown).toBe(false);
      expect(result.tasks[0].operationsKnown).toBe(false);
      expect(result.incomplete).toBe(true);
    },
  );

  it('preserves individually valid references while disclosing malformed entries', () => {
    const result = deriveWorkMap([
      work('a', {
        dependencies: ['b', null, '[Depth limit]', {}],
        operations: [op(), null, '[Sensitive value omitted]', { id: 'bad/id' }],
      }),
    ]);
    expect(result.tasks[0].dependencies).toEqual(['b']);
    expect(result.tasks[0].operations.map((item) => item.id)).toEqual(['op-a']);
    expect(result.tasks[0].dependenciesKnown).toBe(false);
    expect(result.tasks[0].operationsKnown).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it('marks sparse collections incomplete rather than silently skipping their holes', () => {
    const dependencies = new Array<string>(2);
    dependencies[1] = 'b';
    const operations = new Array<ReturnType<typeof op>>(2);
    operations[1] = op();
    const result = deriveWorkMap([work('a', { dependencies, operations })]);
    expect(result.tasks[0].dependencies).toEqual(['b']);
    expect(result.tasks[0].operations.map((item) => item.id)).toEqual(['op-a']);
    expect(result.tasks[0].dependenciesKnown).toBe(false);
    expect(result.tasks[0].operationsKnown).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it.each(['  [Redacted]  ', '\t[Depth limit]\n'])(
    'does not adopt whitespace-wrapped omission marker %j as known text',
    (value) => {
      const result = deriveWorkMap([
        work('a', { waitingOn: value }, { title: value }),
      ]);
      expect(result.tasks[0].title).toBe('Task label unavailable');
      expect(result.tasks[0].coordination['Waiting reason']).toContain(
        'UNKNOWN',
      );
      expect(result.incomplete).toBe(true);
    },
  );

  it('handles an invalid runtime collection without manufacturing an empty authorized result', () => {
    const result = deriveWorkMap(null as never);
    expect(result.tasks).toEqual([]);
    expect(result.operations).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it.each(
    [null, undefined, '[Redacted]', []].map(
      (fields, index) => [index, fields] as const,
    ),
  )(
    'handles malformed fields record %s without adopting unknown facts',
    (_index, fields) => {
      const result = deriveWorkMap([
        work('a', {}, { fields: fields as never }),
      ]);
      expect(result.tasks[0].factsKnown).toBe(false);
      expect(
        result.tasks[0].coordination['Accountable VERA reference'],
      ).toContain('UNKNOWN');
      expect(result.incomplete).toBe(true);
    },
  );

  it('does not convert focus/project/prerequisite or invalid records into task nodes', () => {
    const result = deriveWorkMap([
      work('attention', { target: 'a', tasks: ['a'] }, { kind: 'focus' }),
      work('p', {}, { kind: 'project' }),
      work('setup', {}, { kind: 'prerequisite' }),
      null as never,
    ]);
    expect(result.tasks).toEqual([]);
    expect(result.operations).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it('does not manufacture a known phase, zero revision or healthy coordination from malformed facts', () => {
    const result = deriveWorkMap([
      work(
        'a',
        {
          accountableVERA: undefined,
          originalPrincipal: '[Redacted]',
          project: undefined,
          waitingOn: '[Sensitive value omitted]',
          coordinationRevision: Number.MAX_SAFE_INTEGER + 1,
        },
        {
          title: '[Depth limit]',
          status: 'Unsupported workflow status',
          version: -1,
        },
      ),
    ]);
    const task = result.tasks[0];
    expect(task.title).toBe('Task label unavailable');
    expect(task.phase).toContain('UNKNOWN');
    expect(task.revision).toContain('UNKNOWN');
    expect(
      Object.values(task.coordination).every((value) =>
        value.includes('UNKNOWN'),
      ),
    ).toBe(true);
    expect(result.incomplete).toBe(true);
  });

  it('preserves exact text and recorded coordination zero without treating either as effect authority', () => {
    const item = work(
      'a',
      { waitingOn: '  Recorded reason e\u0301  ', coordinationRevision: 0 },
      { title: '  Recorded objective e\u0301  ' },
    );
    const result = deriveWorkMap([freeze(item)]);
    expect(result.tasks[0].title).toBe(item.title);
    expect(result.tasks[0].coordination['Waiting reason']).toBe(
      item.fields.waitingOn,
    );
    expect(result.tasks[0].coordination['Coordination revision']).toBe('0');
    expect(result.incomplete).toBe(false);
  });

  it.each([
    ['REQUESTED', 'Pending'],
    ['RESERVED', 'Preparing — reserved'],
    ['SENDING', 'Executing — awaiting observation'],
    ['UNKNOWN', 'Outcome uncertain'],
    ['DENIED', 'Denied'],
    ['FAILED_KNOWN_NO_EFFECT', 'Failed — known no effect'],
    ['COMMITTED', 'Result verification unavailable'],
  ])(
    'retains supported %s wire state with its exact projected label and no verification inference',
    (state, label) => {
      const result = deriveWorkMap([
        work('a', { operations: [op({ state, label })] }),
      ]);
      expect(result.operations[0]).toMatchObject({
        state,
        label,
        verified: false,
        verificationScope: null,
        unavailable: false,
      });
      expect(result.incomplete).toBe(false);
    },
  );

  it.each([
    ['LOCAL_FIXTURE', 'Verified fixture result'],
    ['PUBLIC_IMMUTABLE_READ', 'Verified intended read'],
  ])(
    'retains explicit COMMITTED verification only with consistent %s scope and label',
    (verificationScope, label) => {
      const result = deriveWorkMap([
        work('a', {
          operations: [
            op({
              state: 'COMMITTED',
              verified: true,
              verificationScope,
              label,
            }),
          ],
        }),
      ]);
      expect(result.operations[0]).toMatchObject({
        state: 'COMMITTED',
        label,
        verified: true,
        verificationScope,
        unavailable: false,
      });
    },
  );

  it.each([
    ['unknown enum', { state: 'NEW_STATE', known: false }],
    ['missing enum', { state: undefined }],
    ['unknown marker', { state: '[Redacted]' }],
    ['unknown truth', { known: false }],
    ['missing verification', { state: 'COMMITTED', verified: undefined }],
    ['missing scope', { verificationScope: undefined }],
    ['mismatched scope', { verificationScope: 'LOCAL_FIXTURE' }],
    [
      'unsupported scope',
      {
        state: 'COMMITTED',
        verified: true,
        verificationScope: 'CUSTOMER_PRODUCTION',
        label: 'Verified intended read',
      },
    ],
    [
      'verified UNKNOWN',
      {
        verified: true,
        verificationScope: 'LOCAL_FIXTURE',
        label: 'Verified fixture result',
      },
    ],
    ['unbacked positive label', { label: 'Verified fixture result' }],
    [
      'wrong verified label',
      {
        state: 'COMMITTED',
        verified: true,
        verificationScope: 'PUBLIC_IMMUTABLE_READ',
        label: 'Verified fixture result',
      },
    ],
    ['retry claim', { canRetry: true }],
    ['redacted digest', { digest: '[Redacted]' }],
    ['missing digest', { digest: undefined }],
    ['newline digest', { digest: 'd'.repeat(64) + '\n' }],
  ])(
    'fails closed for %s operation metadata without losing a safe inspector reference',
    (_label, changes) => {
      const result = deriveWorkMap([work('a', { operations: [op(changes)] })]);
      expect(result.operations[0].id).toBe('op-a');
      expect(result.operations[0].state).toBeNull();
      expect(result.operations[0].verified).toBeNull();
      expect(result.operations[0].verificationScope).toBeNull();
      expect(result.operations[0].label).toContain('UNKNOWN');
      expect(result.tasks[0].operationsKnown).toBe(false);
      expect(result.incomplete).toBe(true);
    },
  );

  it('measures a large-fanout page without a cap, truncation, recursion or customer SLO claim', () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      work('task-' + index, {
        dependencies: Array.from({ length: 200 }, (_v, n) => 'dependency-' + n),
        operations: Array.from({ length: 40 }, (_v, n) =>
          op({ id: 'op-' + n }),
        ),
      }),
    );
    const envelope = freeze(page(items, { total: 120, cursor: 'next-page' }));
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
    const start = performance.now();
    const result = deriveWorkMap(envelope.items);
    const elapsedMs = performance.now() - start;
    const dependencyReferences = result.tasks.reduce(
      (sum, item) => sum + item.dependencies.length,
      0,
    );
    const operationReferences = result.tasks.reduce(
      (sum, item) => sum + item.operations.length,
      0,
    );
    expect(result.tasks).toHaveLength(60);
    expect(dependencyReferences).toBe(12000);
    expect(operationReferences).toBe(2400);
    expect(result.operations).toHaveLength(40);
    expect(result.incomplete).toBe(false);
    console.info(
      'WORK_MAP_LARGE_FANOUT ' +
        JSON.stringify({
          taskRecords: envelope.items.length,
          dependencyReferences,
          operationReferences,
          distinctOperationNodes: result.operations.length,
          serializedEnvelopeBytes: new TextEncoder().encode(
            JSON.stringify(envelope),
          ).length,
          elapsedMs,
          scope: 'pure unit fixture only; not a customer SLO',
        }),
    );
  });
});

describe('read-only accessible Work map', () => {
  it.each(['issuer|enrolled-subject', 'enrolled/user@example.test'])(
    'preserves accepted opaque session identity %s without treating it as a task identifier',
    (identity) => {
      const envelope = page([work()], {
        session: { ...page().session!, identity },
      });
      expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
      const before = JSON.stringify(envelope);
      render(<WorkMap {...props({ envelope: freeze(envelope) })} />);
      expect(taskArticle()).toBeTruthy();
      expect(
        screen.getByRole('button', { name: /Inspect task task-a$/ }),
      ).toBeTruthy();
      expect(JSON.stringify(envelope)).toBe(before);
    },
  );
  it.each([undefined, '', '   ', 'x'.repeat(4097)])(
    'does not adopt an absent, blank or oversized session identity',
    (identity) => {
      render(
        <WorkMap
          {...props({
            envelope: page([work()], {
              session: { ...page().session!, identity: identity as string },
            }),
          })}
        />,
      );
      expect(screen.getByRole('alert').textContent).toContain(
        'snapshot unavailable or unsupported',
      );
      expect(screen.queryByRole('article')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    },
  );
  it('shows explicit edge direction, loaded/unloaded distinction and only raw-ID task callbacks', () => {
    const onInspectTask = vi.fn();
    render(
      <WorkMap
        {...props({
          envelope: page([
            work('task:a', { dependencies: ['task:b', 'outside'] }),
            work('task:b'),
          ]),
          onInspectTask,
          selectedTaskId: 'task:a',
        })}
      />,
    );
    const card = taskArticle('task:a');
    expect(card.textContent).toContain('task:a depends on task:b');
    expect(card.textContent).toContain(
      'Loaded record: Planned — no workflow admitted',
    );
    expect(card.textContent).toContain(
      'Referenced task not loaded; status UNKNOWN',
    );
    const own = within(card).getByRole('button', {
      name: /Inspect task task:a$/,
    });
    expect(own.getAttribute('aria-current')).toBe('true');
    expect(onInspectTask).not.toHaveBeenCalled();
    fireEvent.click(own);
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Inspect dependency task outside',
      }),
    );
    expect(onInspectTask.mock.calls).toEqual([['task:a'], ['outside']]);
  });

  it('uses exact encoded existing operation/evidence anchors with no inferred event filter or prefetch', () => {
    const { container } = render(
      <WorkMap
        {...props({
          envelope: page([
            work('a', {
              operations: [op({ id: 'operation:op.a' })],
            }),
          ]),
        })}
      />,
    );
    expect(
      screen
        .getByRole('link', { name: 'Inspect operation operation:op.a' })
        .getAttribute('href'),
    ).toBe(
      '/console/evidence?selected=' +
        encodeURIComponent('operation:operation:op.a'),
    );
    expect(
      screen
        .getByRole('link', { name: 'Browse Evidence' })
        .getAttribute('href'),
    ).toBe('/console/evidence');
    expect(
      container.querySelector(
        'link[rel=prefetch],script,img,iframe,canvas,svg',
      ),
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /approve|grant|dispatch|retry|resend|model|activate|workflow/i,
      }),
    ).toBeNull();
    expect(
      screen.getByText(/evidence-event associations are unavailable/),
    ).toBeTruthy();
  });

  it('does not create nodes from waiting text, profile/project references, evidence hashes or approval fields', () => {
    render(
      <WorkMap
        {...props({
          envelope: page([
            work('a', {
              waitingOn: 'mentions-task-b',
              project: 'project-a',
              approval: { allowed: true },
              evidence: 'event-a',
              operations: [op()],
            }),
          ]),
        })}
      />,
    );
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(
      screen.queryByRole('button', {
        name: 'Inspect dependency task mentions-task-b',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Inspect operation op-a' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('link', {
        name: /event-a|project-a|vera-accountable/,
      }),
    ).toBeNull();
    expect(screen.queryByText('event-a')).toBeNull();
    expect(screen.queryByText('true')).toBeNull();
  });

  it('keeps metadata-unavailable different from a genuine UNKNOWN outcome and never paints success', () => {
    const { container } = render(
      <WorkMap
        {...props({
          envelope: page([
            work('a', {
              operations: [
                op(),
                op({ id: 'broken', state: 'COMMITTED', verified: undefined }),
              ],
            }),
          ]),
        })}
      />,
    );
    expect(screen.getByText('Outcome uncertain')).toBeTruthy();
    expect(
      screen.getByText('UNKNOWN — operation state / verification unavailable'),
    ).toBeTruthy();
    expect(screen.getByText(/Wire state: UNKNOWN\./)).toBeTruthy();
    expect(container.querySelector('.verified')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /retry|resend|approve/ }),
    ).toBeNull();
  });

  it('does not treat COMMITTED without explicit verification as success or goal completion', () => {
    render(
      <WorkMap
        {...props({
          envelope: page([
            work('a', {
              operations: [
                op({
                  state: 'COMMITTED',
                  label: 'Result verification unavailable',
                }),
              ],
            }),
          ]),
        })}
      />,
    );
    expect(screen.getByText('Result verification unavailable')).toBeTruthy();
    expect(screen.getByText(/Verification not established/)).toBeTruthy();
    expect(screen.queryByText(/Server-reported verification scope/)).toBeNull();
    expect(
      screen.getByText(/do not prove external effects or goal completion/),
    ).toBeTruthy();
  });

  it('shows the named server-reported verification scope without changing the supplied task phase', () => {
    render(
      <WorkMap
        {...props({
          envelope: page([
            work('a', {
              operations: [
                op({
                  state: 'COMMITTED',
                  label: 'Verified intended read',
                  verified: true,
                  verificationScope: 'PUBLIC_IMMUTABLE_READ',
                }),
              ],
            }),
          ]),
        })}
      />,
    );
    expect(screen.getByText('Verified intended read')).toBeTruthy();
    expect(
      screen.getByText(
        /Server-reported verification scope: PUBLIC_IMMUTABLE_READ/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Projected work phase: Planned — no workflow admitted'),
    ).toBeTruthy();
  });

  it('admits a true empty authorized view only with current complete scope, no cursor and known zero total', () => {
    render(<WorkMap {...props({ envelope: page([]) })} />);
    expect(
      screen.getByText(
        'No task records in this authorized view. This is not a readiness or success result.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it.each([
    ['partial', { completeness: 'partial' as const }, {}],
    ['cursor', { cursor: 'next', total: null }, {}],
    ['unknown total', { total: null }, {}],
    ['nonzero total', { total: 10 }, {}],
    ['stale', {}, { stale: true }],
    ['offline', {}, { offline: true }],
    ['failed read', {}, { readUnavailable: true }],
    ['loading', {}, { loading: true }],
  ])(
    'does not claim a globally empty or all-clear result for %s',
    (_label, overrides, state) => {
      render(
        <WorkMap {...props({ envelope: page([], overrides), ...state })} />,
      );
      expect(
        screen.queryByText(
          'No task records in this authorized view. This is not a readiness or success result.',
        ),
      ).toBeNull();
      expect(
        screen.getByText(/No usable task records on this loaded page/),
      ).toBeTruthy();
    },
  );

  it('discloses complete current-page cursor bounds and preserves unknown collection counts', () => {
    render(
      <WorkMap
        {...props({
          envelope: page([work()], { total: null, cursor: 'next' }),
        })}
      />,
    );
    expect(screen.getByText(/Additional authorized pages exist/)).toBeTruthy();
    expect(
      screen.getByText(/1 loaded task records · Collection count unknown/),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        /complete graph|0 records in the authorized filtered collection/i,
      ),
    ).toBeNull();
  });

  it('combines stale/offline/partial/read-failure notices without hiding retained data or its provenance', () => {
    render(
      <WorkMap
        {...props({
          envelope: page([work()], { completeness: 'partial' }),
          stale: true,
          offline: true,
          readUnavailable: true,
        })}
      />,
    );
    const status = screen.getByRole('status').textContent;
    expect(status).toContain('Stale snapshot');
    expect(status).toContain('Offline');
    expect(status).toContain('Partial snapshot');
    expect(status).toContain('read unavailable');
    expect(taskArticle()).toBeTruthy();
    expect(
      screen.getByText(/Retained page · LOCAL_FIXTURE · observed/),
    ).toBeTruthy();
  });

  it.each([
    ['absent', null],
    ['missing tenant scope', page([], { session: undefined })],
    [
      'invalid tenant identifier',
      page([], { session: { ...page().session!, tenant: 'other/tenant' } }),
    ],
    ['unknown schema', { ...page([]), schema_version: 2 } as never],
    [
      'unsafe projection revision',
      page([], { projection_version: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ['invalid observed time', page([], { observed_at: 'not-a-time' })],
    ['invalid total', page([], { total: -1 })],
    ['mismatched total', page([work()], { total: 0 })],
    ['extra CSRF field', { ...page(), csrf: 'must-be-omitted' } as never],
  ])(
    'does not adopt %s envelope facts or create navigation targets',
    (_label, envelope) => {
      render(<WorkMap {...props({ envelope })} />);
      expect(screen.getByRole('alert').textContent).toContain(
        'snapshot unavailable or unsupported',
      );
      expect(screen.queryByRole('article')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    },
  );

  it('shows loading without inventing placeholder workflow nodes or triggering navigation', () => {
    const onInspectTask = vi.fn();
    render(
      <WorkMap {...props({ envelope: null, loading: true, onInspectTask })} />,
    );
    expect(
      screen.getByText(/Waiting for an accepted tenant-scoped Work snapshot/),
    ).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    expect(onInspectTask).not.toHaveBeenCalled();
  });

  it('treats valid attention-group rows as unavailable Work metadata, not task aliases or empty work', () => {
    render(
      <WorkMap
        {...props({
          envelope: page([
            work('task:a', { target: 'a', tasks: ['a'] }, { kind: 'focus' }),
          ]),
        })}
      />,
    );
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('UNKNOWN');
    expect(screen.getByText(/No usable task records/)).toBeTruthy();
  });

  it('shows partial reference warnings rather than silently reporting malformed collections as none', () => {
    render(
      <WorkMap
        {...props({
          envelope: page([
            work('a', {
              dependencies: ['b', '[Redacted]'],
              operations: [op(), '[Depth limit]'],
            }),
          ]),
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Inspect dependency task b' }),
    ).toBeTruthy();
    expect(screen.getByText(/Dependency metadata UNKNOWN/)).toBeTruthy();
    expect(screen.getByText(/Operation metadata UNKNOWN/)).toBeTruthy();
    expect(screen.queryByText(/No dependency references recorded/)).toBeNull();
    expect(screen.queryByText(/No operation references recorded/)).toBeNull();
  });

  it('renders supplied labels as inert exact text and keeps IDs wrapped', () => {
    const title = '  <img src=x onerror=alert(1)> e\u0301  ';
    const longId = 'a'.repeat(128);
    const { container } = render(
      <WorkMap
        {...props({
          envelope: page([
            work(
              longId,
              {
                waitingOn: '<script>alert(1)</script>',
                operations: [op({ id: longId })],
              },
              { title },
            ),
          ]),
        })}
      />,
    );
    expect(container.querySelector('img,script,iframe,svg,canvas')).toBeNull();
    expect(within(taskArticle(longId)).getByRole('button').textContent).toBe(
      title,
    );
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Inspect operation ' + longId })
        .className,
    ).toContain('wrap');
    expect(
      container.querySelectorAll('button button,button a,a button,a a'),
    ).toHaveLength(0);
    expect(
      [...container.querySelectorAll('button')].every(
        (button) => button.type === 'button',
      ),
    ).toBe(true);
  });

  it('supports native keyboard task inspection without focus stealing, implicit commands or nested controls', async () => {
    const user = userEvent.setup();
    const onInspectTask = vi.fn();
    render(
      <WorkMap
        {...props({
          envelope: page([
            work('a', { dependencies: ['b'], operations: [op()] }),
          ]),
          onInspectTask,
        })}
      />,
    );
    expect(onInspectTask).not.toHaveBeenCalled();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: 'Browse Evidence' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Inspect task a$/ }),
    );
    await user.keyboard('{Enter}');
    expect(onInspectTask).toHaveBeenCalledExactlyOnceWith('a');
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Inspect dependency task b' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: 'Inspect operation op-a' }),
    );
    expect(onInspectTask).toHaveBeenCalledTimes(1);
  });

  it('does not retain old scope/page data, mutate frozen envelopes or navigate after a parent scope replacement', () => {
    const first = freeze(
      page([work('old', { dependencies: ['outside'], operations: [op()] })]),
    );
    const before = JSON.stringify(first);
    const onInspectTask = vi.fn();
    const { rerender } = render(
      <WorkMap {...props({ envelope: first, onInspectTask })} />,
    );
    const second = freeze(
      page([work('new')], {
        session: {
          ...page().session!,
          identity: 'human-b',
          tenant: 'tenant-b',
        },
        projection_version: 18,
      }),
    );
    rerender(<WorkMap {...props({ envelope: second, onInspectTask })} />);
    expect(screen.queryByRole('article', { name: 'Task old' })).toBeNull();
    expect(taskArticle('new')).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: 'Inspect operation op-a' }),
    ).toBeNull();
    expect(JSON.stringify(first)).toBe(before);
    expect(onInspectTask).not.toHaveBeenCalled();
    rerender(
      <WorkMap
        {...props({ envelope: null, readUnavailable: true, onInspectTask })}
      />,
    );
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('renders every reference beyond incidental historical redaction sizes without inventing a cap', () => {
    const dependencies = Array.from(
      { length: 250 },
      (_, index) => 'dependency-' + index,
    );
    const operations = Array.from({ length: 210 }, (_, index) =>
      op({ id: 'operation-' + index }),
    );
    const envelope = freeze(
      page([work('large', { dependencies, operations })], {
        total: 2,
        cursor: 'next',
      }),
    );
    const before = JSON.stringify(envelope);
    render(<WorkMap {...props({ envelope })} />);
    const card = within(taskArticle('large'));
    expect(
      card.getAllByRole('button', { name: /^Inspect dependency task / }),
    ).toHaveLength(250);
    expect(
      card.getAllByRole('link', { name: /^Inspect operation / }),
    ).toHaveLength(210);
    expect(
      card.getByRole('button', {
        name: 'Inspect dependency task dependency-249',
      }),
    ).toBeTruthy();
    expect(
      card.getByRole('link', { name: 'Inspect operation operation-209' }),
    ).toBeTruthy();
    expect(JSON.stringify(envelope)).toBe(before);
    console.info(
      'WORK_MAP_RENDER_FANOUT ' +
        JSON.stringify({
          taskRecords: 1,
          dependencyReferences: dependencies.length,
          operationReferences: operations.length,
          serializedEnvelopeBytes: new TextEncoder().encode(
            JSON.stringify(envelope),
          ).length,
          scope:
            'jsdom DOM coverage only; not browser responsiveness or customer SLO evidence',
        }),
    );
  });
});
