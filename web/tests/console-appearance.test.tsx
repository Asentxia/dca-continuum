import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvelopeSchema } from '@continuum/contracts';
import { ConsoleApp } from '../components/ConsoleApp';
import { command, read, type ClientEnvelope } from '@/lib/api';

const navigation = vi.hoisted(() => ({ search: '' }));
vi.mock('@/lib/api', () => ({ read: vi.fn(), command: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));

const storageKey = 'continuum.console.appearance';
const destinations = [
  ['work', 'Work'],
  ['projects', 'Projects'],
  ['agents', 'Agents / VERA'],
  ['approvals', 'Approvals'],
  ['evidence', 'Evidence'],
  ['recovery', 'Recovery'],
  ['governance', 'Governance'],
  ['authority', 'Authority'],
  ['security', 'Security'],
  ['computers', 'Computers'],
  ['context', 'State / Context'],
  ['integrations', 'Integrations'],
  ['incidents', 'Incidents'],
  ['notifications', 'Notifications'],
  ['usage', 'Usage / Limits'],
  ['settings', 'Settings'],
  ['setup', 'Onboarding / Setup'],
];

beforeEach(() => {
  navigation.search = '';
  localStorage.clear();
  vi.mocked(read).mockReset().mockRejectedValue(new Error('READ_UNAVAILABLE'));
  vi.mocked(command).mockReset();
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage = null;
      close() {}
      postMessage() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function loadedAppearanceEnvelope(
  state: 'REQUESTED' | 'UNKNOWN',
  eligible: boolean,
): ClientEnvelope {
  const parameters = {
    path: 'appearance-unit-test.txt',
    payload: { text: 'Read-only unit fixture.', revision: 2 },
    flags: ['exact-review', 'no-live-effect'],
  };
  const binding = {
    operation: 'op-appearance',
    principal: 'vera-unit-test',
    action: 'write_unit_fixture',
    resource: 'unit-test:appearance/exact-file',
    grant: 'grant-unit-test',
    grantVersion: 3,
    principalEpoch: 2,
    principalGeneration: 4,
    parameters,
  };
  return freeze({
    ...EnvelopeSchema.parse({
      schema_version: 1,
      server_time: '2026-10-14T00:00:00Z',
      observed_at: '2026-10-14T00:00:00Z',
      fresh_until: '2026-10-14T00:00:30Z',
      projection_version: 9,
      source_revision: 'appearance-unit-test-only',
      completeness: 'complete',
      cursor: null,
      total: 1,
      items: [
        {
          id: binding.operation,
          kind: 'operation',
          title: 'Exact appearance test action',
          version: 7,
          status:
            state === 'UNKNOWN'
              ? 'Outcome uncertain'
              : 'Awaiting exact approval',
          fields: {
            ...binding,
            effectState: state,
            digest: 'd'.repeat(64),
            canonicalBinding: binding,
            deadline: '2026-10-14T00:01:00Z',
            maximumApprovalExpiry: '2026-10-14T00:00:30Z',
            verificationMethod: 'authoritative-read-back',
            approvalRevision: 5,
            contextQuarantined: !eligible,
          },
          eligibility: {
            allowed: eligible,
            reason: eligible
              ? 'Fresh server eligibility permits this exact approval.'
              : state === 'UNKNOWN'
                ? 'Observation only. An uncertain effect cannot be retried.'
                : 'Server eligibility denies approval of quarantined context.',
          },
        },
      ],
      features: {
        commands: {
          state: 'available',
          reason: 'Fresh human commands available in this unit fixture only.',
          scope: 'LOCAL_FIXTURE',
        },
      },
      scope: 'LOCAL_FIXTURE',
      session: {
        identity: 'appearance-unit-session',
        tenant: 'appearance-unit-tenant',
        principal: null,
        expires: Date.parse('2026-10-14T00:05:00Z'),
        fresh_mfa: true,
      },
    }),
    csrf: 'appearance-unit-test-marker',
  });
}

describe('loaded appearance remains non-authoritative', () => {
  it.each([
    ['approval-enabled', 'approvals', 'REQUESTED', true],
    ['eligibility-denied', 'approvals', 'REQUESTED', false],
    ['UNKNOWN recovery', 'recovery', 'UNKNOWN', false],
  ] as const)(
    'preserves loaded %s authority through System → Light → Dark → System',
    async (_name, section, state, eligible) => {
      // Freeze polling and monotonic eligibility, not the appearance interaction.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      vi.spyOn(performance, 'now').mockReturnValue(1000);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      const envelope = loadedAppearanceEnvelope(state, eligible);
      const item = envelope.items[0];
      const envelopeBefore = JSON.stringify(envelope);
      navigation.search = new URLSearchParams({ selected: item.id }).toString();
      vi.mocked(read).mockResolvedValue(envelope);
      await act(async () => {
        render(<ConsoleApp section={section} mode="LOCAL_FIXTURE" />);
      });
      const inspector = screen.getByRole('complementary', {
        name: 'Contextual inspector',
      });
      const select = screen.getByRole('combobox', { name: 'Appearance' });
      const root = select.closest('.console')!;
      const user = userEvent.setup();
      const readBaseline = structuredClone(vi.mocked(read).mock.calls);
      expect(readBaseline).toEqual([
        [section, {}],
        [section, { id: item.id }],
      ]);
      const binding = JSON.stringify(item.fields.canonicalBinding, null, 2);
      const parameters = JSON.stringify(item.fields.parameters, null, 2);
      const protectedState = () => ({
        inspector: inspector.textContent,
        payloads: Array.from(inspector.querySelectorAll('pre')).map(
          (payload) => payload.textContent,
        ),
        buttons: Array.from(inspector.querySelectorAll('button')).map(
          (button) => ({ name: button.textContent, disabled: button.disabled }),
        ),
        release: screen.getByRole('note').textContent,
        commandStatus: screen.getByText(
          'Review durable state. Every enabled command is checked again on the server.',
        ).textContent,
      });
      const assertAuthority = () => {
        expect(
          within(inspector).getByRole('heading', { level: 2 }).textContent,
        ).toBe(item.title);
        expect(protectedState().payloads).toContain(binding);
        expect(JSON.parse(binding).parameters).toEqual(item.fields.parameters);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByRole('note').textContent).toContain(
          'Production blocked · Scheduler held · Canary no-go',
        );
        expect(
          screen.queryByRole('button', {
            name: /retry|resend|dispatch|renew/i,
          }),
        ).toBeNull();
        if (state === 'REQUESTED') {
          expect(
            within(inspector).getByLabelText('Complete exact parameters')
              .textContent,
          ).toBe(parameters);
          expect(
            (
              within(inspector).getByRole('button', {
                name: 'Approve exact action',
              }) as HTMLButtonElement
            ).disabled,
          ).toBe(!eligible);
          expect(
            within(inspector).getByText(item.eligibility!.reason, {
              exact: false,
            }),
          ).toBeTruthy();
        } else {
          expect(within(inspector).getByText('UNKNOWN')).toBeTruthy();
          const uncertainty = within(inspector).getByText('Outcome uncertain');
          expect(uncertainty.classList.contains('attention')).toBe(true);
          expect(uncertainty.classList.contains('verified')).toBe(false);
          expect(
            within(inspector).queryByRole('button', {
              name: 'Approve exact action',
            }),
          ).toBeNull();
        }
        if (!eligible) {
          expect(
            within(inspector).getByText(
              'Quarantined context is not an admitted fact and is not effect authority.',
            ),
          ).toBeTruthy();
        }
        expect(JSON.stringify(envelope)).toBe(envelopeBefore);
        expect(vi.mocked(read).mock.calls).toEqual(readBaseline);
        expect(vi.mocked(command)).not.toHaveBeenCalled();
      };
      expect((select as HTMLSelectElement).value).toBe('system');
      expect(root.getAttribute('data-appearance')).toBe('system');
      expect(localStorage.getItem(storageKey)).toBeNull();
      assertAuthority();
      const beforeAppearance = protectedState();
      for (const preference of ['light', 'dark', 'system']) {
        await user.selectOptions(select, preference);
        expect((select as HTMLSelectElement).value).toBe(preference);
        expect(root.getAttribute('data-appearance')).toBe(preference);
        expect(localStorage.getItem(storageKey)).toBe(
          preference === 'system' ? null : preference,
        );
        assertAuthority();
        expect(protectedState()).toEqual(beforeAppearance);
      }
    },
  );
});

async function renderConsole(
  section = 'work',
  mode: 'LOCAL_FIXTURE' | 'STAGING' = 'LOCAL_FIXTURE',
) {
  const result = render(<ConsoleApp section={section} mode={mode} />);
  await screen.findByText(
    'Records unavailable. This is not an empty or all-clear result.',
  );
  return result;
}

describe('console-only appearance and navigation', () => {
  it('prioritizes core work without losing any existing desktop or mobile destination', async () => {
    await renderConsole();
    const sidebar = screen.getByLabelText('Main navigation');
    const navigation = within(sidebar).getByRole('navigation');
    expect(
      within(navigation)
        .getAllByRole('link')
        .map((link) => [link.getAttribute('href'), link.textContent?.trim()]),
    ).toEqual(
      destinations.map(([id, title]) => [
        `/console/${id}`,
        `${id === 'work' ? '◈' : id === 'approvals' ? '✓' : id === 'agents' ? '◇' : '·'}${title}`,
      ]),
    );
    const core = within(navigation).getByRole('group', { name: 'Core work' });
    expect(
      within(core)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(destinations.slice(0, 6).map(([id]) => `/console/${id}`));
    const mobile = screen.getByText('Continuum navigation').closest('details')!;
    await userEvent.setup().click(screen.getByText('Continuum navigation'));
    expect(mobile.open).toBe(true);
    for (const [id, title] of destinations) {
      expect(
        within(navigation)
          .getByRole('link', { name: title })
          .getAttribute('href'),
      ).toBe(`/console/${id}`);
      expect(
        within(mobile).getByRole('link', { name: title }).getAttribute('href'),
      ).toBe(`/console/${id}`);
    }
  });

  it.each(destinations)(
    'preserves the %s heading and current link',
    async (id, title) => {
      await renderConsole(id);
      expect(
        screen.getByRole('heading', { name: title, level: 1 }),
      ).toBeTruthy();
      const navigation = within(
        screen.getByLabelText('Main navigation'),
      ).getByRole('navigation');
      const current = navigation.querySelectorAll('[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(current[0].getAttribute('href')).toBe(`/console/${id}`);
    },
  );

  it.each(['light', 'dark', 'system'])(
    'accepts the stored %s enum',
    async (preference) => {
      localStorage.setItem(storageKey, preference);
      const { container } = await renderConsole();
      expect(
        (
          screen.getByRole('combobox', {
            name: 'Appearance',
          }) as HTMLSelectElement
        ).value,
      ).toBe(preference);
      expect(
        container.querySelector('.console')?.getAttribute('data-appearance'),
      ).toBe(preference);
    },
  );

  it.each(['LIGHT', 'null', '{"theme":"dark"}', 'STAGING', ''])(
    'ignores the invalid stored appearance %j',
    async (preference) => {
      localStorage.setItem(storageKey, preference);
      const { container } = await renderConsole();
      expect(
        container.querySelector('.console')?.getAttribute('data-appearance'),
      ).toBe('system');
    },
  );

  it('keeps the system dark palette in the scoped color-scheme media query', () => {
    const styles = readFileSync(resolve('app/globals.css'), 'utf8');
    const explicit = styles.match(
      /\.console\[data-appearance='dark'\] \{([^}]+)\}/,
    )?.[1];
    const system = styles.match(
      /@media \(prefers-color-scheme: dark\) \{\s*\.console\[data-appearance='system'\] \{([^}]+)\}/,
    )?.[1];
    expect(explicit).toBeTruthy();
    expect(system).toBeTruthy();
    const declarations = (block: string) =>
      block
        .trim()
        .split('\n')
        .map((line) => line.trim());
    expect(declarations(system!)).toEqual(declarations(explicit!));
    expect(explicit).toContain('color-scheme: dark');
  });

  it('uses a labelled native preference with keyboard focus and no authority or read side effects', async () => {
    const user = userEvent.setup();
    const { container } = await renderConsole();
    const select = screen.getByRole('combobox', { name: 'Appearance' });
    expect((select as HTMLSelectElement).value).toBe('system');
    select.focus();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Sign out' }),
    );
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(select);
    await user.selectOptions(select, 'light');
    expect(localStorage.getItem(storageKey)).toBe('light');
    expect(
      container.querySelector('.console')?.getAttribute('data-appearance'),
    ).toBe('light');
    await user.selectOptions(select, 'dark');
    expect(localStorage.getItem(storageKey)).toBe('dark');
    await user.selectOptions(select, 'system');
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(document.documentElement.getAttribute('data-appearance')).toBeNull();
    expect(document.body.getAttribute('data-appearance')).toBeNull();
    expect(vi.mocked(read)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(command)).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('falls back to system and remains usable when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError');
    });
    const user = userEvent.setup();
    const { container } = await renderConsole();
    const select = screen.getByRole('combobox', { name: 'Appearance' });
    expect((select as HTMLSelectElement).value).toBe('system');
    await user.selectOptions(select, 'dark');
    expect(
      container.querySelector('.console')?.getAttribute('data-appearance'),
    ).toBe('dark');
    await user.selectOptions(select, 'system');
    expect((select as HTMLSelectElement).value).toBe('system');
  });

  it.each(['LOCAL_FIXTURE', 'STAGING'] as const)(
    'retains honest development and blocked release states in %s',
    async (mode) => {
      await renderConsole('work', mode);
      expect(
        screen.getByText('Development console · not production'),
      ).toBeTruthy();
      expect(screen.getByRole('note').textContent).toContain(
        'Production blocked · Scheduler held · Canary no-go',
      );
      expect(
        screen.queryByText('Canonical local release candidate'),
      ).toBeNull();
      expect(
        (screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    },
  );
});
