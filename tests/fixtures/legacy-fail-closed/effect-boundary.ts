import type { PoolClient } from 'pg';
// Fail-closed guard, not an inline replacement for independent authorization/transport.
export class EffectBoundary {
  async commitTimeRecheckAndDispatch(
    _client: PoolClient,
    _tenantId: string,
    _operation: unknown,
    _activePolicy: string,
  ): Promise<string> {
    throw new Error(
      'Legacy effect execution disabled pending qualified controller migration',
    );
  }
}
