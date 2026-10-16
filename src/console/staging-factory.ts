import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { IdentityVerifier, type IdentityConfig } from '../identity-provider.js';
import { AuthorityService } from '../authority-service.js';
import { ProductService } from '../product-service.js';
import { ConsoleReads } from './reads.js';
import { ConsoleCommands } from './commands.js';
import { CursorCodec } from './pagination.js';
import { consoleApi } from './api.js';
export function stagingHumanConsole(
  pools: { reader: pg.Pool; commands: pg.Pool },
  identity: IdentityConfig,
  release: {
    fence: string;
    sourceRevision: string;
    approvedConfigReference: string;
  },
) {
  if (
    identity.kind !== 'user' ||
    !release.approvedConfigReference ||
    !release.fence
  )
    throw Error('Approved human staging configuration required');
  const verifier = new IdentityVerifier(identity),
    authority = new AuthorityService(
      pools.commands,
      pools.commands,
      undefined,
      release.fence,
    );
  const reads = new ConsoleReads(
    pools.reader,
    new CursorCodec(randomBytes(32)),
    'STAGING',
    release.sourceRevision,
    release.fence,
  );
  const commands = new ConsoleCommands(
    pools.commands,
    authority,
    new ProductService(pools.commands, release.fence),
    release.fence,
    'STAGING',
  );
  // No provider/signing/workload credentials. Mount behind approved TLS/private ingress.
  // Live human commands deliberately stay disabled pending separately approved qualification.
  return consoleApi(verifier, reads, commands);
}
