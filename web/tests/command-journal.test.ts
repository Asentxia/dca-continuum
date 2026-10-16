import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commandJournalKey,
  rememberCommand,
  restoreCommandJournal,
  clearCommandJournal,
} from '../lib/command-journal';

const pending = { identity: 'owner-a', key: 'request-a' };
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('non-authoritative command correlation journal', () => {
  it('stores only the enrolled-identity reference and command key', () => {
    expect(rememberCommand(pending)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(commandJournalKey)!)).toEqual(
      pending,
    );
    expect(restoreCommandJournal('owner-a')).toEqual({
      available: true,
      pending,
    });
  });
  it('does not expose a private reference to another account', () => {
    rememberCommand(pending);
    expect(restoreCommandJournal('owner-b')).toEqual({
      available: false,
      pending: null,
    });
    expect(JSON.parse(sessionStorage.getItem(commandJournalKey)!)).toEqual(
      pending,
    );
  });
  it.each(['issuer|enrolled-subject', 'enrolled/user@example.test'])(
    'keeps server-issued identity %s opaque rather than treating it as a command identifier',
    (identity) => {
      const reference = { ...pending, identity };
      expect(rememberCommand(reference)).toBe(true);
      expect(restoreCommandJournal(identity).pending).toEqual(reference);
    },
  );
  it.each([
    '{',
    'null',
    '{"identity":"owner-a","key":"bad key"}',
    '{"identity":"owner-a","key":"request-a","authority":true}',
  ])(
    'refuses malformed or expanded metadata %s without assuming an empty history',
    (value) => {
      sessionStorage.setItem(commandJournalKey, value);
      expect(restoreCommandJournal('owner-a')).toEqual({
        available: false,
        pending: null,
      });
      expect(sessionStorage.getItem(commandJournalKey)).toBe(value);
    },
  );
  it('does not erase another in-progress binding', () => {
    rememberCommand(pending);
    expect(clearCommandJournal({ ...pending, key: 'different-request' })).toBe(
      false,
    );
    expect(restoreCommandJournal('owner-a').pending).toEqual(pending);
    expect(clearCommandJournal(pending)).toBe(true);
    expect(restoreCommandJournal('owner-a').pending).toBeNull();
  });
  it('reports inaccessible storage as unavailable, not proof of an empty journal', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw Error('storage unavailable');
    });
    expect(restoreCommandJournal('owner-a')).toEqual({
      available: false,
      pending: null,
    });
    expect(rememberCommand(pending)).toBe(false);
    expect(clearCommandJournal(pending)).toBe(false);
  });
  it('refuses an invalid reference before storing anything', () => {
    expect(rememberCommand({ ...pending, identity: '' })).toBe(false);
    expect(sessionStorage.getItem(commandJournalKey)).toBeNull();
  });
  it.each(['', '   ', '\t', 'x'.repeat(4097)])(
    'an invalid current identity cannot delete the unresolved correlation',
    (identity) => {
      rememberCommand(pending);
      const raw = sessionStorage.getItem(commandJournalKey);
      expect(restoreCommandJournal(identity)).toEqual({
        available: false,
        pending: null,
      });
      expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
      expect(restoreCommandJournal(pending.identity).pending).toEqual(pending);
    },
  );
  it('retains a foreign-account hold privately until its matching account establishes an outcome', () => {
    rememberCommand(pending);
    const raw = sessionStorage.getItem(commandJournalKey);
    expect(restoreCommandJournal('owner-b')).toEqual({
      available: false,
      pending: null,
    });
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    expect(
      rememberCommand({ identity: 'owner-b', key: 'different-account' }),
    ).toBe(false);
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    expect(restoreCommandJournal('owner-a').pending).toEqual(pending);
  });
  it('a second request cannot overwrite an unresolved same-account binding', () => {
    rememberCommand(pending);
    const raw = sessionStorage.getItem(commandJournalKey);
    expect(rememberCommand({ ...pending, key: 'second-request' })).toBe(false);
    expect(sessionStorage.getItem(commandJournalKey)).toBe(raw);
    expect(rememberCommand(pending)).toBe(true);
  });
});
