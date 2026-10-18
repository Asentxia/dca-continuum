import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WorkspaceNavigation,
  dailyDestinations,
  advancedDestinations,
} from '../components/WorkspaceNavigation';
import { WorkspaceGuide } from '../components/WorkspaceGuide';

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
afterEach(cleanup);

describe('work-first navigation', () => {
  it('starts with five daily destinations, without losing technical routes', async () => {
    render(<WorkspaceNavigation section="work" />);
    const everyday = screen.getByRole('group', { name: 'Everyday work' });
    expect(
      within(everyday)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(dailyDestinations.map(([id]) => '/console/' + id));
    const disclosure = screen
      .getByText('More workspace tools')
      .closest('details')!;
    expect(disclosure.open).toBe(false);
    await userEvent.setup().click(screen.getByText('More workspace tools'));
    expect(disclosure.open).toBe(true);
    const all = screen.getAllByRole('link');
    expect(new Set(all.map((a) => a.getAttribute('href'))).size).toBe(17);
    for (const [id, label] of advancedDestinations)
      expect(
        screen.getByRole('link', { name: label }).getAttribute('href'),
      ).toBe('/console/' + id);
  });

  it('opens technical navigation on a technical deep link and marks one current page', () => {
    render(<WorkspaceNavigation section="recovery" />);
    expect(
      screen.getByText('More workspace tools').closest('details')!.open,
    ).toBe(true);
    expect(
      screen
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page'),
    ).toEqual([screen.getByRole('link', { name: 'Recovery' })]);
  });

  it('keeps the disclosure and revealed destinations focusable', async () => {
    render(<WorkspaceNavigation section="work" />);
    const user = userEvent.setup();
    const summary = screen.getByText('More workspace tools');
    summary.focus();
    expect(document.activeElement).toBe(summary);
    // jsdom does not implement native Enter activation of summary; the
    // canonical Chromium test verifies that behavior with the real browser.
    await user.click(summary);
    expect(summary.closest('details')!.open).toBe(true);
    const evidence = screen.getByRole('link', { name: 'Evidence' });
    evidence.focus();
    expect(document.activeElement).toBe(evidence);
  });
});

describe('work-first guidance', () => {
  it.each([
    ['work', 'Describe a task', 'task'],
    ['projects', 'Organize a project', 'project'],
    ['agents', 'Create a VERA profile', 'vera'],
    ['integrations', 'Set up a model connection', 'model'],
  ])(
    'uses the existing %s creation path only on an explicit click',
    async (section, label, action) => {
      const onCreate = vi.fn();
      render(
        <WorkspaceGuide
          section={section}
          canAct
          busy={false}
          onCreate={onCreate}
        />,
      );
      expect(onCreate).not.toHaveBeenCalled();
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: label }));
      expect(onCreate).toHaveBeenCalledExactlyOnceWith(action);
    },
  );

  it.each([false, true])(
    'never enables creation without current authorization (busy=%s)',
    async (busy) => {
      const onCreate = vi.fn();
      render(
        <WorkspaceGuide
          section="work"
          canAct={false}
          busy={busy}
          onCreate={onCreate}
        />,
      );
      const button = screen.getByRole('button', {
        name: 'Describe a task',
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await userEvent.setup().click(button);
      expect(onCreate).not.toHaveBeenCalled();
      expect(screen.getByText(/fresh, authorized session/)).toBeTruthy();
    },
  );

  it('blocks duplicate creation while a command is busy', () => {
    render(<WorkspaceGuide section="work" canAct busy onCreate={vi.fn()} />);
    expect(
      (
        screen.getByRole('button', {
          name: 'Describe a task',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('explains task creation and keeps uncertainty one click away, without invented readiness', async () => {
    render(
      <WorkspaceGuide section="work" canAct busy={false} onCreate={vi.fn()} />,
    );
    expect(screen.getByText(/does not start an agent/)).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Inspect uncertain outcomes' })
        .getAttribute('href'),
    ).toBe('/console/recovery');
    expect(screen.queryByText(/all clear|100%|ready to run/i)).toBeNull();
    const setup = screen
      .getByText('New here? See the three-step setup')
      .closest('details')!;
    expect(setup.open).toBe(false);
    await userEvent
      .setup()
      .click(screen.getByText('New here? See the three-step setup'));
    expect(setup.open).toBe(true);
    expect(
      screen.getByRole('list', { name: 'How to start working' }).children,
    ).toHaveLength(3);
  });

  it('does not confuse model connection with live verification or a dollar cap', () => {
    render(
      <WorkspaceGuide
        section="integrations"
        canAct
        busy={false}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByText(/not a dollar spending cap/)).toBeTruthy();
    expect(screen.getByText(/does not verify live readiness/)).toBeTruthy();
  });

  it('makes approval deliberate and never offers a one-click blanket approval', () => {
    render(
      <WorkspaceGuide
        section="approvals"
        canAct
        busy={false}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByText(/Approval is not proof of execution/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not invent guidance or controls for an unknown section', () => {
    const { container } = render(
      <WorkspaceGuide
        section="future-autopilot"
        canAct
        busy={false}
        onCreate={vi.fn()}
      />,
    );
    expect(container.childElementCount).toBe(0);
  });
});
