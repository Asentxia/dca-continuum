export class ResponseOrder {
  private generation = 0;
  private version = -1;
  invalidate() {
    this.generation++;
    this.version = -1;
  }
  issue() {
    return ++this.generation;
  }
  current(request: number) {
    return request === this.generation;
  }
  accept(request: number, version: number) {
    if (request !== this.generation || version < this.version) return false;
    this.version = version;
    return true;
  }
}
export function freshLifetime(server: string, until: string) {
  return Math.max(0, Math.min(30000, Date.parse(until) - Date.parse(server)));
}
export function canMutate(
  valid: boolean,
  received: number,
  lifetime: number,
  now: number,
  online: boolean,
  hidden: boolean,
) {
  return valid && online && !hidden && now - received < lifetime;
}
export function stableOrder<T extends { id: string }>(
  previous: T[],
  next: T[],
  frozen: boolean,
) {
  if (!frozen || previous.length === 0) return next;
  const byId = new Map(next.map((x) => [x.id, x]));
  return previous.map((x) => byId.get(x.id) ?? x);
}
export function changedRows(
  previous: { id: string }[],
  next: { id: string }[],
) {
  const ids = new Set(previous.map((x) => x.id));
  return next.filter((x) => !ids.has(x.id)).length;
}
