import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { issueCapability } from '../src/capability.js';
import { fence } from './helpers.js';
export const secrets = {
  providerSecret: randomBytes(32).toString('hex'),
  capabilitySecret: randomBytes(32).toString('hex'),
};
export function capability(ids: string[], opts: Record<string, unknown> = {}) {
  return issueCapability(secrets.capabilitySecret, {
    deploymentFence: fence,
    tenant: 'a',
    principal: 'agent',
    epoch: 1,
    generation: 1,
    operations: ids,
    expires: Date.now() + 300000,
    ...opts,
  });
}
export function config(path: string, body: Record<string, unknown>) {
  fs.writeFileSync(path, JSON.stringify({ ...secrets, fence, ...body }), {
    mode: 0o600,
  });
  fs.chmodSync(path, 0o600);
}
export async function start(
  script: string,
  path: string,
  label: string,
): Promise<ChildProcess> {
  const p = spawn(process.execPath, [script, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream('.artifacts/core/' + label + '.log', {
    flags: 'a',
  });
  p.stdout!.pipe(log);
  p.stderr!.pipe(log);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(Error('process readiness timeout ' + label)),
      20000,
    );
    p.stdout!.on('data', (b) => {
      if (String(b).includes('READY')) {
        clearTimeout(t);
        resolve();
      }
    });
    p.once('exit', (code, signal) => {
      clearTimeout(t);
      reject(Error('early exit ' + code + ' ' + signal));
    });
  });
  return p;
}
export async function stop(p: ChildProcess | undefined) {
  if (p && p.exitCode === null && p.signalCode === null) {
    p.kill('SIGKILL');
    await new Promise<void>((r) => p.once('exit', () => r()));
  }
}
