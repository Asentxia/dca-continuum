import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './implementation-helpers.js';
import { admin } from './helpers.js';
import { pool, canonical, sha } from '../src/db.js';
import { RecoveryService, type AuthorityRevocation } from '../src/recovery.js';
import { LocalIndependentFenceStore } from '../src/fence-store.js';
const recoveryDb = pool('ct_recovery');
after(async () => {
  await Promise.all([recoveryDb.end(), admin.end()]);
});
async function policyFor(
  ownerSubject: string,
  journal: { records: AuthorityRevocation[] },
  inventory: { operations: never[] },
  approved: { digest?: string },
) {
  return {
    async authorizeOperator(a: { subject: string; kind: string }) {
      if (a.subject !== ownerSubject || a.kind !== 'user')
        throw Error('not the local test recovery operator');
    },
    async readAuthorityJournal() {
      return {
        records: journal.records,
        digest: sha(canonical(journal.records)),
      };
    },
    async readOperationInventory() {
      return {
        reference: 'audit-local-empty-inventory',
        operations: inventory.operations,
        digest: sha(canonical(inventory.operations)),
        complete: true,
      };
    },
    async verifyActivationApproval(reference: string, digest: string) {
      if (
        reference !== 'audit-local-manifest-approval' ||
        digest !== approved.digest
      )
        throw Error('exact manifest approval required');
    },
  };
}
test('AUDIT-JOURNAL: activation refuses journal and inventory drift and a failed external open', async () => {
  const f = await fixture('audit-journal');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-audit-fence-'));
  try {
    const owner = await f.actor('user');
    const grant = 'audit-journal-grant';
    await f.authority.createGrant(owner, {
      id: grant,
      principal: f.principal,
      action: 'write',
      resource: 'fixture-object',
      expires: new Date(Date.now() + 3600000).toISOString(),
      maxCost: 1,
      budget: 1,
    });
    const journal = { records: [] as AuthorityRevocation[] };
    const inventory = { operations: [] as never[] };
    const approved: { digest?: string } = {};
    const store = new LocalIndependentFenceStore(dir);
    await store.initialize({
      revision: 1,
      fence: 'fixture-fence-v1',
      blocked: false,
      authorityDigest: sha(canonical([])),
    });
    const recovery = new RecoveryService(
      recoveryDb,
      store,
      {
        supports: () => false,
        lookup: async () => {
          throw Error('no external requests in this test');
        },
      },
      await policyFor(owner.subject, journal, inventory, approved),
    );
    const run = await recovery.begin(owner);
    await recovery.markBackupGap(owner, run.id);
    await recovery.applyAuthorityJournal(owner, run.id);
    await recovery.importInventory(owner, run.id);
    approved.digest = sha(canonical(await recovery.manifest(owner, run.id)));
    journal.records = [{ tenant: 'a', grant, version: 2 }];
    await assert.rejects(
      recovery.activate(owner, run.id, 'audit-local-manifest-approval'),
      /journal\/inventory drift/,
    );
    journal.records = [];
    inventory.operations = [{ binding: { id: 'drift' } }] as unknown as never[];
    await assert.rejects(
      recovery.activate(owner, run.id, 'audit-local-manifest-approval'),
      /journal\/inventory drift/,
    );
    inventory.operations = [];
    const failing = new RecoveryService(
      recoveryDb,
      {
        read: () => store.read(),
        advance: (expected, digest) => store.advance(expected, digest),
        activate: async () => {
          throw Error('external activation interrupted');
        },
      },
      {
        supports: () => false,
        lookup: async () => {
          throw Error('no external requests in this test');
        },
      },
      await policyFor(owner.subject, journal, inventory, approved),
    );
    await assert.rejects(
      failing.activate(owner, run.id, 'audit-local-manifest-approval'),
      /external activation interrupted/,
    );
    const control = (
      await admin.query('SELECT blocked FROM ct.control WHERE singleton')
    ).rows[0];
    const external = await store.read();
    assert.equal(control.blocked, true);
    assert.equal(external.blocked, true);
    const row = (
      await admin.query(
        'SELECT revoked,version FROM ct.grants WHERE tenant=$1 AND id=$2',
        ['a', grant],
      )
    ).rows[0];
    assert.equal(row.revoked, false);
    assert.equal(Number(row.version), 1);
  } finally {
    await f.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
