import { describe, it, expect } from 'vitest';
import {
  ResponseOrder,
  canMutate,
  freshLifetime,
  stableOrder,
  changedRows,
} from '../lib/client-state';
describe('A01/A04/A18/A39 client correctness', () => {
  it('Rejects slow old responses and older source versions', () => {
    const x = new ResponseOrder(),
      a = x.issue(),
      b = x.issue();
    expect(x.current(a)).toBe(false);
    expect(x.current(b)).toBe(true);
    expect(x.accept(a, 5)).toBe(false);
    expect(x.accept(b, 5)).toBe(true);
    const c = x.issue();
    expect(x.accept(c, 4)).toBe(false);
  });
  it('Account invalidation rejects previously issued reads', () => {
    const x = new ResponseOrder(),
      a = x.issue();
    x.invalidate();
    expect(x.accept(a, 8)).toBe(false);
  });
  it('MFA/eligibility expires using monotonic elapsed time, not user clock', () => {
    expect(freshLifetime('2026-10-09T00:00:00Z', '2026-10-09T00:00:05Z')).toBe(
      5000,
    );
    expect(canMutate(true, 100, 5000, 5100, true, false)).toBe(false);
    expect(canMutate(true, 100, 5000, 1000, false, false)).toBe(false);
    expect(canMutate(true, 100, 5000, 1000, true, true)).toBe(false);
  });
  it('Focus keeps selection ordering while critical arrivals are counted', () => {
    const prev = [{ id: 'a' }, { id: 'b' }],
      next = [{ id: 'critical' }, { id: 'b' }, { id: 'a' }];
    expect(stableOrder(prev, next, true).map((x) => x.id)).toEqual(['a', 'b']);
    expect(changedRows(prev, next)).toBe(1);
    expect(stableOrder(prev, next, false)[0].id).toBe('critical');
    expect(stableOrder([], next, true)).toEqual(next);
  });
});
