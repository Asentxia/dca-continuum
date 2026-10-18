import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelConnectionPanel,
  ModelText,
  TryVeraForm,
} from '../components/ModelConnectionPanel';

vi.mock('@/lib/api', () => ({
  read: vi.fn(async () => ({
    items: [{ id: 'vera-1', kind: 'vera', title: 'Desk agent' }],
  })),
  sealModelKey: vi.fn(async () => ({ connection: 'gemini-1', sealed: true })),
  command: vi.fn(),
}));

afterEach(() => cleanup());

describe('model connection flow', () => {
  it('keeps setup open and renders a hostile answer as text', async () => {
    const user = userEvent.setup();
    const commands: string[] = [];
    const view = render(
      <ModelConnectionPanel
        csrf="csrf"
        canAct
        busy={false}
        existing={{
          id: 'gemini-1',
          status: 'SEALED',
          supportedModels: ['models/mock-text'],
          verification: 'not verified',
        }}
        onCommand={async (value) => {
          commands.push(value.kind);
          return {
            status: 'APPLIED',
            result: {
              verification: 'mock-tested / live test pending',
              message: 'Mock-tested / live test pending.',
            },
          };
        }}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByLabelText('Model')).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText('Model'),
      'models/mock-text',
    );
    await user.selectOptions(screen.getByLabelText('VERA'), 'vera-1');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await user.click(screen.getByRole('button', { name: 'Choose model' }));
    await user.click(screen.getByRole('button', { name: 'Assign to VERA' }));
    expect(commands).toEqual([
      'set_model_connection_limits',
      'test_model_connection',
      'select_model_connection_model',
      'assign_model_connection',
    ]);
    expect(screen.getByRole('status').textContent).toMatch(
      /mock-tested \/ live test pending/,
    );
    view.unmount();
    const hostile = '<img src=x onerror=alert(1)>';
    render(
      <TryVeraForm
        connectionId="gemini-1"
        principal="vera-1"
        answer={hostile}
        canAct
        busy={false}
        onCommand={async () => ({ status: 'DENIED' })}
        onClose={() => undefined}
      />,
    );
    const text = screen.getByText(hostile);
    expect(text.tagName).toBe('P');
    expect(text.innerHTML).toContain('&lt;img');
    render(<ModelText text={hostile} />);
  });
});
