import { Identifier } from '@continuum/contracts';

// Correlation metadata only. Never store a token, CSRF value, command payload,
// receipt, eligibility, or claimed authority here. The server authorizes lookup.
export const commandJournalKey = 'continuum.console.unconfirmed-command';
export type PendingCommand = { identity: string; key: string };
export type JournalRead = {
  available: boolean;
  pending: PendingCommand | null;
};

export function validJournalIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 4096 && value.trim().length > 0
  );
}

function valid(value: unknown): value is PendingCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    Object.keys(fields).length === 2 &&
    Object.hasOwn(fields, 'identity') &&
    Object.hasOwn(fields, 'key') &&
    validJournalIdentity(fields.identity) &&
    Identifier.safeParse(fields.key).success
  );
}

export function restoreCommandJournal(identity: string): JournalRead {
  // Missing context is not an account switch or an empty command history.
  if (!validJournalIdentity(identity))
    return { available: false, pending: null };
  try {
    const raw = sessionStorage.getItem(commandJournalKey);
    if (raw === null) return { available: true, pending: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!valid(parsed)) return { available: false, pending: null };
    if (parsed.identity !== identity) {
      // Conceal another account's reference without discarding its unresolved hold.
      return { available: false, pending: null };
    }
    return {
      available: true,
      pending: { identity: parsed.identity, key: parsed.key },
    };
  } catch {
    // Inaccessible tracking is not proof that no earlier request was submitted.
    return { available: false, pending: null };
  }
}

export function rememberCommand(pending: PendingCommand): boolean {
  if (!valid(pending)) return false;
  try {
    const raw = sessionStorage.getItem(commandJournalKey);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (
        !valid(stored) ||
        stored.identity !== pending.identity ||
        stored.key !== pending.key
      )
        return false;
    }
    sessionStorage.setItem(commandJournalKey, JSON.stringify(pending));
    return (
      sessionStorage.getItem(commandJournalKey) === JSON.stringify(pending)
    );
  } catch {
    return false;
  }
}

export function clearCommandJournal(pending: PendingCommand): boolean {
  try {
    const raw = sessionStorage.getItem(commandJournalKey);
    if (raw === null) return true;
    const stored: unknown = JSON.parse(raw);
    if (
      valid(stored) &&
      stored.identity === pending.identity &&
      stored.key === pending.key
    )
      sessionStorage.removeItem(commandJournalKey);
    return sessionStorage.getItem(commandJournalKey) === null;
  } catch {
    return false;
  }
}
