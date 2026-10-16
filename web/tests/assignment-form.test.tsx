import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { AssignmentForm } from '../components/AssignmentForm';
import { read } from '@/lib/api';

vi.mock('@/lib/api', () => ({ read: vi.fn() }));
afterEach(cleanup);

describe('assignment refresh', () => {
  it('a failed refresh cannot submit the previous machine', async () => {
    vi.mocked(read).mockResolvedValueOnce({
      items: [
        {
          id: 'machine-a',
          kind: 'machine',
          title: 'Machine A',
          version: 1,
          status: 'Active',
          fields: { kind: 'machine', active: true, VERA: 'vera-a' },
        },
      ],
      csrf: 'token',
    } as never);
    render(
      <AssignmentForm
        item={{
          id: 'op',
          kind: 'operation',
          title: 'Op',
          version: 1,
          status: 'Pending',
          fields: {
            principal: 'vera-a',
            deadline: '2026-10-11T00:00:00Z',
            workloadAssignments: [],
          },
        }}
        canAct
        busy={false}
        onCommand={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review machine assignment' }),
    );
    await screen.findByRole('button', { name: 'Record exact assignment' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Review machine assignment' }),
    );
    vi.mocked(read).mockRejectedValueOnce(new Error('refresh failed'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Review machine assignment' }),
    );
    await waitFor(() => {
      expect(
        (
          screen.getByRole('button', {
            name: 'Record exact assignment',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
  });
});
