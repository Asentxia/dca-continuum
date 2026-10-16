import '../../../internal/fixtures/temporal-logging.js';
import fs from 'node:fs';
import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { effect } from './effect-activity.js';
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const connection = await NativeConnection.connect({ address: c.address });
const worker = await Worker.create({
  connection,
  namespace: 'default',
  taskQueue: c.queue,
  workflowsPath: fileURLToPath(
    new URL(
      c.version === 2 ? './temporal-v2.js' : './temporal-v1.js',
      import.meta.url,
    ),
  ),
  activities: {
    effect: async (job: any, index: number) => {
      const result = await effect(job, index);
      if (c.killAfterEffectId === job.id && index === 0)
        process.kill(process.pid, 'SIGKILL');
      return result;
    },
  },
  maxCachedWorkflows: 0,
  stickyQueueScheduleToStartTimeout: '1 second',
});
console.log('READY');
await worker.run();
await connection.close();
