export interface Job {
  id: string;
  schemaVersion: 1 | 2;
  operations: string[];
  socket: string;
  capability: string;
  waitMs: number;
}
export interface Progress {
  phase: 'BEFORE_WAIT' | 'WAITING' | 'DONE' | 'BLOCKED';
  schemaVersion: number;
  done: number[];
}
