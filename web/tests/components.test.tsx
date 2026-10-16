import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Badge, Value, Confirm } from '../components/Primitives';
import { ReviewPanel } from '../components/ReviewPanel';
afterEach(cleanup);
describe('A16/A17/A22/A30 safe product components', () => {
  it('User HTML remains text, not an executable image', () => {
    const { container } = render(
      <Value value={'<img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
  it('Outcome uncertainty has explicit text and is not a success style', () => {
    const { container } = render(<Badge value="Outcome uncertain" />);
    expect(screen.getByText('Outcome uncertain')).toBeTruthy();
    expect(container.querySelector('.verified')).toBeNull();
    expect(container.querySelector('.attention')).toBeTruthy();
  });
  it('Stale eligibility disables exact approval even when the object once allowed it', () => {
    render(
      <ReviewPanel
        item={{
          id: 'op',
          kind: 'operation',
          title: 'Exact test action',
          version: 1,
          status: 'Pending',
          fields: {
            effectState: 'REQUESTED',
            parameters: { value: 'read-only' },
            digest: 'd'.repeat(64),
            approvalRevision: 0,
          },
          eligibility: { allowed: true, reason: 'Recorded' },
        }}
        canAct={false}
        busy={false}
        onCommand={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Approve exact action',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
  it('Revocation modal defaults focus to safe cancellation and escape returns it', () => {
    const close = vi.fn();
    render(
      <Confirm
        title="Revoke?"
        onCancel={close}
        onConfirm={vi.fn()}
        busy={false}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Keep grant' }),
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
