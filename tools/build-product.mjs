import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../dist-product/', import.meta.url);
try {
  const info = await fs.lstat(output);
  if (info.isSymbolicLink()) throw Error('Refusing a linked product build directory');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// Only the fixed generated output is cleared; source/history/archives are untouched.
await fs.rm(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.product.json'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
