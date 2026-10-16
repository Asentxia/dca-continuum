export interface ProviderObservation {
  tenant: string;
  operation: string;
  digest: string;
  idempotency_key: string;
  payload: unknown;
}
export interface ProviderAdapter {
  readonly provider: string;
  supports(o: Record<string, any>): boolean;
  send(o: Record<string, any>): Promise<void>;
  lookup(o: Record<string, any>): Promise<ProviderObservation[]>;
}
