import Runloop from '@runloop/api-client';
import type { ComputerDriver, Placement, PlacementSpec } from './computers.js';
export interface ManagedStageConfig {
  enabled: boolean;
  approvalReference: string;
  blueprintId: string;
  networkPolicyId: string;
}
export function mapRunloopStatus(status: string) {
  if (status === 'running') return 'RUNNING' as const;
  if (status === 'shutdown') return 'STOPPED' as const;
  if (status === 'provisioning') return 'STARTING' as const;
  throw Error('unmapped provider status');
}
export class RunloopDriver implements ComputerDriver {
  constructor(
    private config: ManagedStageConfig,
    private credential: () => Promise<string>,
    private testFetch?: typeof fetch,
  ) {}
  private async client() {
    if (
      !this.config.enabled ||
      !this.config.approvalReference ||
      !this.config.blueprintId ||
      !this.config.networkPolicyId
    )
      throw Error('managed staging driver disabled or unapproved');
    // Explicit URL prevents SDK environment-variable endpoint overrides. No mutation retries.
    return new Runloop({
      bearerToken: await this.credential(),
      baseURL: 'https://api.runloop.ai',
      timeout: 5000,
      maxRetries: 0,
      fetch: (async (u: any, o: any) => {
        if (new URL(String(u)).origin !== 'https://api.runloop.ai')
          throw Error('managed endpoint mismatch');
        return (this.testFetch ?? fetch)(u, { ...o, redirect: 'error' });
      }) as any,
    });
  }
  private view(x: any): Placement {
    if (
      !x?.id ||
      !x.metadata?.ct_tenant ||
      !x.metadata?.ct_computer ||
      !Number.isSafeInteger(Number(x.metadata.ct_generation))
    )
      throw Error('managed placement metadata');
    return {
      id: x.id,
      tenant: x.metadata.ct_tenant,
      computer: x.metadata.ct_computer,
      generation: Number(x.metadata.ct_generation),
      status: mapRunloopStatus(x.status),
    };
  }
  async start(s: PlacementSpec) {
    const client = await this.client();
    const x = await client.devboxes.create({
      blueprint_id: this.config.blueprintId,
      name: `ct-${s.computer}-${s.generation}`,
      metadata: {
        ct_tenant: s.tenant,
        ct_computer: s.computer,
        ct_generation: String(s.generation),
        ct_request: s.requestId,
      },
      launch_parameters: { network_policy_id: this.config.networkPolicyId },
      environment_variables: {
        CT_COMPUTER: s.computer,
        CT_GENERATION: String(s.generation),
      },
    });
    return this.view(x);
  }
  async inspect(id: string) {
    return this.view(await (await this.client()).devboxes.retrieve(id));
  }
  async stop(id: string) {
    const c = await this.client();
    await c.devboxes.shutdown(id);
    const view = await c.devboxes.retrieve(id);
    if (view.status !== 'shutdown')
      throw Error('managed termination not verified');
  }
}
