import { DefaultLogger, Runtime } from '@temporalio/worker';
import { redactLog } from '../../src/security/redact.js';
import { assertLocalFixtures } from '../../src/runtime-profile.js';
assertLocalFixtures('Temporal fixture logging');
Runtime.install({
  logger: new DefaultLogger('WARN', (entry) =>
    console.error(
      JSON.stringify(
        redactLog({
          level: entry.level,
          message: entry.message,
          metadata: entry.meta,
        }),
      ),
    ),
  ),
});
