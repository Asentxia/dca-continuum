import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CommandSchema,
  CommandInputs,
  type ConsoleItem,
  type HumanCommand,
} from '@continuum/contracts';
import { VeraProfileForm } from '../components/VeraProfileForm';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
let randomUUID: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  let sequence = 0;
  randomUUID = vi.fn(
    () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'),
  );
  fetchSpy = vi.fn(() => {
    throw Error('Unexpected network request');
  });
  vi.stubGlobal('crypto', { randomUUID });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function profile(
  fields: Record<string, unknown> = {},
  changes: Partial<ConsoleItem> = {},
): ConsoleItem {
  return {
    id: 'vera-a',
    kind: 'vera',
    title: 'Fallback title must not be used',
    version: 42,
    status: 'Paused VERA',
    fields: {
      VERA: 'vera-a',
      profileName: '  Verá e\u0301  ',
      description: '  Exact details\nSecond line  ',
      profileRevision: 4,
      profileCreatedBy: 'human-creator',
      principalEpoch: '11',
      principalGeneration: 16,
      executionMode: 'PAUSED',
      ...fields,
    },
    ...changes,
  };
}
function nameField() {
  return screen.getByRole('textbox', { name: 'Name' }) as HTMLTextAreaElement;
}
function descriptionField() {
  return screen.getByRole('textbox', {
    name: 'Description',
  }) as HTMLTextAreaElement;
}
function form() {
  return screen.getByRole('form');
}
function submitButton() {
  return screen.getByRole('button', {
    name: /Record VERA profile|Record profile changes/,
  }) as HTMLButtonElement;
}
function changeText(name: string, description = '') {
  fireEvent.change(nameField(), { target: { value: name } });
  fireEvent.change(descriptionField(), { target: { value: description } });
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('VERA metadata profile commands', () => {
  it('creates the exact command with one stable draft target/key and expected zero', async () => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    const onClose = vi.fn();
    const props = {
      mode: 'create' as const,
      canAct: true,
      busy: false,
      onCommand,
      onClose,
    };
    const { rerender } = render(<VeraProfileForm {...props} />);
    expect(randomUUID).toHaveBeenCalledTimes(2);
    const name = '  Verá e\u0301  ';
    const description = '  Exact details\nSecond line  ';
    changeText(name, description);
    rerender(<VeraProfileForm {...props} />);
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    const expected: HumanCommand = {
      schema_version: 1,
      idempotency_key: secondId,
      kind: 'create_vera',
      target: 'vera-' + firstId,
      expected_version: 0,
      input: { name, description },
    };
    expect(onCommand).toHaveBeenCalledExactlyOnceWith(expected);
    expect(CommandSchema.parse(expected)).toEqual(expected);
    expect(CommandInputs.create_vera.parse(expected.input)).toEqual(
      expected.input,
    );
    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('edits loaded profile text exactly and binds profileRevision, not version/epoch/generation', async () => {
    const item = profile();
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    const onClose = vi.fn();
    render(
      <VeraProfileForm
        mode="edit"
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
        onClose={onClose}
      />,
    );
    expect(nameField().value).toBe(item.fields.profileName);
    expect(descriptionField().value).toBe(item.fields.description);
    expect(nameField().value).not.toBe(item.title);
    fireEvent.click(submitButton());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const command = onCommand.mock.calls[0][0];
    expect(command).toEqual({
      schema_version: 1,
      idempotency_key: firstId,
      kind: 'update_vera_profile',
      target: item.id,
      expected_version: 4,
      input: {
        name: item.fields.profileName,
        description: item.fields.description,
      },
    });
    expect(Object.keys(command.input).sort()).toEqual(['description', 'name']);
    expect(CommandInputs.update_vera_profile.parse(command.input)).toEqual(
      command.input,
    );
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('preserves untouched CRLF text and Unicode rather than normalizing the command binding', async () => {
    const item = profile({
      profileName: '  First\r\nSecond e\u0301  ',
      description: '  First\r\nSecond\rThird e\u0301  ',
    });
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    render(
      <VeraProfileForm
        mode="edit"
        item={item}
        canAct
        busy={false}
        onCommand={onCommand}
        onClose={vi.fn()}
      />,
    );
    fireEvent.submit(form());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0][0].input).toEqual({
      name: item.fields.profileName,
      description: item.fields.description,
    });
  });

  it('does not adopt an existing or legacy item as the target of creation', async () => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    render(
      <VeraProfileForm
        mode="create"
        item={profile({ profileRevision: null })}
        canAct
        busy={false}
        onCommand={onCommand}
        onClose={vi.fn()}
      />,
    );
    expect(nameField().value).toBe('');
    changeText('New profile');
    fireEvent.submit(form());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0][0]).toMatchObject({
      target: 'vera-' + firstId,
      expected_version: 0,
      kind: 'create_vera',
      input: { name: 'New profile', description: '' },
    });
  });

  it.each([1, Number.MAX_SAFE_INTEGER - 1])(
    'accepts safe profile revision %s',
    async (revision) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode="edit"
          item={profile({ profileRevision: revision })}
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      fireEvent.submit(form());
      await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
      expect(onCommand.mock.calls[0][0].expected_version).toBe(revision);
    },
  );

  it.each([
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '4'],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['unsafe-to-increment', Number.MAX_SAFE_INTEGER],
    ['unsafe-integer', Number.MAX_SAFE_INTEGER + 1],
  ])(
    'rejects %s profile revision without using principal/item versions',
    (_label, revision) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode="edit"
          item={profile({ profileRevision: revision })}
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByRole('alert').textContent).toContain(
        'Profile unavailable',
      );
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(submitButton().disabled).toBe(true);
      fireEvent.submit(form());
      expect(onCommand).not.toHaveBeenCalled();
      expect(randomUUID).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'legacy',
      {
        profileName: null,
        description: null,
        profileRevision: null,
        profileCreatedBy: null,
      },
    ],
    ['missing name', { profileName: undefined }],
    ['missing description', { description: undefined }],
    ['null description', { description: null }],
    ['missing creator', { profileCreatedBy: undefined }],
    ['mismatched stable identity', { VERA: 'vera-other' }],
    ['missing stable identity', { VERA: undefined }],
    ['redacted name', { profileName: '[Redacted]' }],
    ['redacted description', { description: '[Sensitive value omitted]' }],
    ['depth-limited description', { description: '[Depth limit]' }],
    ['redacted creator', { profileCreatedBy: '[Redacted]' }],
    ['non-text name', { profileName: { redacted: true } }],
  ])(
    'does not adopt a %s profile or substitute its title/empty description',
    (_label, fields) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode="edit"
          item={profile(fields)}
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(
        screen.queryByDisplayValue('Fallback title must not be used'),
      ).toBeNull();
      expect(submitButton().disabled).toBe(true);
      fireEvent.submit(form());
      expect(onCommand).not.toHaveBeenCalled();
    },
  );

  it('does not silently adopt a profile arriving after an initially missing edit item', () => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    const props = {
      mode: 'edit' as const,
      canAct: true,
      busy: false,
      onCommand,
      onClose: vi.fn(),
    };
    const { rerender } = render(<VeraProfileForm {...props} />);
    rerender(<VeraProfileForm {...props} item={profile()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.submit(form());
    expect(onCommand).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['missing', undefined],
    ['redacted', '[Redacted]'],
    ['array', []],
  ] as const)(
    'rejects a malformed fields record %s without crashing or adopting it',
    (_label, fields) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode="edit"
          item={profile({}, { fields: fields as never })}
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByRole('alert').textContent).toContain(
        'Profile unavailable',
      );
      expect(screen.queryByRole('textbox')).toBeNull();
      fireEvent.submit(form());
      expect(onCommand).not.toHaveBeenCalled();
      expect(randomUUID).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['wrong entity kind', { kind: 'principal' }],
    ['identifier with a trailing newline', { id: 'vera-a\n' }],
  ])('rejects an unsupported %s record', (_label, changes) => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    render(
      <VeraProfileForm
        mode="edit"
        item={profile({}, changes)}
        canAct
        busy={false}
        onCommand={onCommand}
        onClose={vi.fn()}
      />,
    );
    fireEvent.submit(form());
    expect(onCommand).not.toHaveBeenCalled();
    expect(submitButton().disabled).toBe(true);
  });

  it.each([
    ['revision drift', profile({ profileRevision: 5 })],
    ['name drift', profile({ profileName: 'New stored name' })],
    ['description drift', profile({ description: 'New stored details' })],
    ['creator drift', profile({ profileCreatedBy: 'other-creator' })],
    ['different target', profile({ VERA: 'vera-b' }, { id: 'vera-b' })],
    ['missing current profile', undefined],
    ['partial current profile', profile({ description: null })],
  ])(
    'blocks %s without replacing the unsent draft or regenerating its key',
    (_label, next) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      const props = {
        mode: 'edit' as const,
        canAct: true,
        busy: false,
        onCommand,
        onClose: vi.fn(),
      };
      const { rerender } = render(
        <VeraProfileForm {...props} item={profile()} />,
      );
      changeText('My unsent name', 'My unsent description');
      rerender(<VeraProfileForm {...props} item={next} />);
      expect(nameField().value).toBe('My unsent name');
      expect(descriptionField().value).toBe('My unsent description');
      expect(submitButton().disabled).toBe(true);
      expect(screen.getByRole('alert').textContent).toContain(
        'loaded profile changed',
      );
      fireEvent.submit(form());
      expect(onCommand).not.toHaveBeenCalled();
      expect(randomUUID).toHaveBeenCalledTimes(1);
    },
  );

  it('does not confuse unrelated principal/item counter changes with profile revision drift', async () => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    const props = {
      mode: 'edit' as const,
      canAct: true,
      busy: false,
      onCommand,
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <VeraProfileForm {...props} item={profile()} />,
    );
    rerender(
      <VeraProfileForm
        {...props}
        item={profile(
          { principalEpoch: 99, principalGeneration: 100 },
          { version: 99 },
        )}
      />,
    );
    expect(submitButton().disabled).toBe(false);
    fireEvent.submit(form());
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand.mock.calls[0][0].expected_version).toBe(4);
  });

  it('blocks a mode switch instead of converting the existing draft binding', () => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    const props = { canAct: true, busy: false, onCommand, onClose: vi.fn() };
    const { rerender } = render(<VeraProfileForm {...props} mode="create" />);
    changeText('Draft name');
    rerender(<VeraProfileForm {...props} mode="edit" item={profile()} />);
    fireEvent.submit(form());
    expect(submitButton().disabled).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it.each(['create', 'edit'] as const)(
    'enforces nonblank/name bounds and description bounds in %s, including bypassed native validation',
    (mode) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode={mode}
          item={mode === 'edit' ? profile() : undefined}
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      for (const name of ['', ' \t\n\u00a0 ', 'N'.repeat(201)]) {
        changeText(name);
        expect(submitButton().disabled).toBe(true);
        expect(nameField().getAttribute('aria-invalid')).toBe('true');
        fireEvent.submit(form());
      }
      changeText('N', 'D'.repeat(8001));
      expect(descriptionField().getAttribute('aria-invalid')).toBe('true');
      fireEvent.submit(form());
      expect(onCommand).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'edit'] as const)(
    'accepts a one-character name and explicitly empty description in %s',
    async (mode) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode={mode}
          item={mode === 'edit' ? profile({ description: '' }) : undefined}
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      changeText('N', '');
      fireEvent.submit(form());
      await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
      expect(onCommand.mock.calls[0][0].input).toEqual({
        name: 'N',
        description: '',
      });
    },
  );

  it.each(['create', 'edit'] as const)(
    'accepts exact upper text bounds in %s with only name and description in the body',
    async (mode) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode={mode}
          item={mode === 'edit' ? profile() : undefined}
          canAct
          busy={false}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      const name = 'N'.repeat(200);
      const description = 'D'.repeat(8000);
      changeText(name, description);
      fireEvent.submit(form());
      await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
      expect(onCommand.mock.calls[0][0].input).toEqual({ name, description });
      expect(Object.keys(onCommand.mock.calls[0][0].input).sort()).toEqual([
        'description',
        'name',
      ]);
    },
  );

  it.each([
    ['create', false, false],
    ['edit', false, false],
    ['create', true, true],
    ['edit', true, true],
  ] as const)(
    'blocks %s when canAct=%s busy=%s, including synthetic submit',
    (mode, canAct, busy) => {
      const onCommand = vi.fn(async (_command: HumanCommand) => {});
      render(
        <VeraProfileForm
          mode={mode}
          item={mode === 'edit' ? profile() : undefined}
          canAct={canAct}
          busy={busy}
          onCommand={onCommand}
          onClose={vi.fn()}
        />,
      );
      if (mode === 'create') changeText('Valid name');
      expect(nameField().disabled).toBe(true);
      expect(descriptionField().disabled).toBe(true);
      expect(submitButton().disabled).toBe(true);
      fireEvent.submit(form());
      expect(onCommand).not.toHaveBeenCalled();
    },
  );

  it('obeys newly denied/busy parent props without resetting the draft', () => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    const props = { mode: 'create' as const, onCommand, onClose: vi.fn() };
    const { rerender } = render(
      <VeraProfileForm {...props} canAct busy={false} />,
    );
    changeText('Exact draft', 'Exact details');
    rerender(<VeraProfileForm {...props} canAct={false} busy={false} />);
    fireEvent.submit(form());
    rerender(<VeraProfileForm {...props} canAct busy />);
    fireEvent.submit(form());
    expect(onCommand).not.toHaveBeenCalled();
    expect(nameField().value).toBe('Exact draft');
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it('holds double clicks and synthetic duplicates locally until the callback settles', async () => {
    const waiting = deferred();
    const onCommand = vi.fn((_command: HumanCommand) => waiting.promise);
    const onClose = vi.fn();
    render(
      <VeraProfileForm
        mode="create"
        canAct
        busy={false}
        onCommand={onCommand}
        onClose={onClose}
      />,
    );
    changeText('One draft');
    fireEvent.click(submitButton());
    fireEvent.submit(form());
    fireEvent.click(submitButton());
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(submitButton().disabled).toBe(true);
    expect(form().getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      waiting.resolve();
      await waiting.promise;
    });
    expect(submitButton().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it.each(['create', 'edit'] as const)(
    'handles %s callback failure without disclosure, changed binding, resend, key regeneration or auto-close',
    async (mode) => {
      const waiting = deferred();
      const onCommand = vi.fn((_command: HumanCommand) => waiting.promise);
      const onClose = vi.fn();
      const props = {
        mode,
        item: mode === 'edit' ? profile() : undefined,
        canAct: true,
        busy: false,
        onCommand,
        onClose,
      };
      const { rerender } = render(<VeraProfileForm {...props} />);
      changeText('  Exact failed draft  ', '  Exact failed details  ');
      fireEvent.submit(form());
      await act(async () => {
        waiting.reject(Error('private callback diagnostic'));
        await waiting.promise.catch(() => {});
      });
      expect(screen.getByRole('alert').textContent).toContain(
        'No automatic resend',
      );
      expect(screen.queryByText(/private callback diagnostic/)).toBeNull();
      expect(onCommand).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      const original = onCommand.mock.calls[0][0];
      expect(nameField().readOnly).toBe(true);
      expect(descriptionField().readOnly).toBe(true);
      fireEvent.change(nameField(), { target: { value: 'Changed body' } });
      fireEvent.change(descriptionField(), {
        target: { value: 'Changed details' },
      });
      onCommand.mockImplementation(async (_command: HumanCommand) => {});
      rerender(<VeraProfileForm {...props} />);
      fireEvent.submit(form()); // Explicit action only, same binding.
      await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
      expect(onCommand.mock.calls[1][0]).toEqual(original);
      expect(randomUUID).toHaveBeenCalledTimes(mode === 'create' ? 2 : 1);
      expect(nameField().value).toBe('  Exact failed draft  ');
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it('leaves terminal/unconfirmed eligibility with the parent after the callback', async () => {
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    const onClose = vi.fn();
    const props = {
      mode: 'edit' as const,
      item: profile(),
      busy: false,
      onCommand,
      onClose,
    };
    const { rerender } = render(<VeraProfileForm {...props} canAct />);
    fireEvent.submit(form());
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    rerender(<VeraProfileForm {...props} canAct={false} />);
    fireEvent.submit(form());
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /retry|resend/i })).toBeNull();
  });

  it('shows creation PAUSED/requires setup and immutable metadata as text, not controls', () => {
    const { rerender, container } = render(
      <VeraProfileForm
        mode="create"
        canAct
        busy={false}
        onCommand={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/PAUSED · requires setup/)).toBeTruthy();
    expect(
      screen.getByText(/does not configure services or start execution/),
    ).toBeTruthy();
    rerender(
      <VeraProfileForm
        key="loaded-edit"
        mode="edit"
        item={profile()}
        canAct
        busy={false}
        onCommand={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('vera-a')).toBeTruthy();
    expect(screen.getByText('human-creator')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
    expect(screen.getByText('16')).toBeTruthy();
    expect(container.querySelectorAll('input,select,textarea').length).toBe(2);
    expect(
      screen.queryByRole('button', {
        name: /activate|resume|model|Computer|enroll|grant|approve|workflow/i,
      }),
    ).toBeNull();
  });

  it('keeps profile markup inert and exposes labelled native controls and help', () => {
    const { container } = render(
      <VeraProfileForm
        mode="edit"
        item={profile({
          profileName: '<img src=x onerror=alert(1)>',
          description: '<script>alert(1)</script>',
        })}
        canAct
        busy={false}
        onCommand={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector('img,script,svg,iframe')).toBeNull();
    expect(nameField().getAttribute('maxlength')).toBe('200');
    expect(descriptionField().getAttribute('maxlength')).toBe('8000');
    for (const field of [nameField(), descriptionField()]) {
      expect(
        document.getElementById(field.getAttribute('aria-describedby')!)
          ?.textContent,
      ).toBeTruthy();
    }
    expect(form().getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('supports keyboard navigation and calls onClose only for explicit Close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    render(
      <VeraProfileForm
        mode="create"
        canAct
        busy={false}
        onCommand={onCommand}
        onClose={onClose}
      />,
    );
    await user.tab();
    expect(document.activeElement).toBe(nameField());
    await user.type(nameField(), 'Keyboard profile');
    await user.tab();
    expect(document.activeElement).toBe(descriptionField());
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close form' }),
    );
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('keeps explicit Close usable while the parent denies commands', () => {
    const onClose = vi.fn();
    const onCommand = vi.fn(async (_command: HumanCommand) => {});
    render(
      <VeraProfileForm
        mode="create"
        canAct={false}
        busy
        onCommand={onCommand}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close form' }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
    expect(onCommand).not.toHaveBeenCalled();
  });
});
