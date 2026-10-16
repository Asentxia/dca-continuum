import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { readLimitedBody } from './bounded-body.js';
import { canonical } from './db.js';
import type { FenceStore, IndependentFence } from './fence-store.js';
import type { S3StageConfig, StagingAwsCredential } from './s3-object-store.js';
export class S3FenceStore implements FenceStore {
  constructor(
    private config: S3StageConfig,
    private credentials: () => Promise<StagingAwsCredential>,
    private testSend?: (command: any) => Promise<any>,
  ) {}
  private async send(command: any) {
    if (
      !this.config.enabled ||
      !this.config.approvalReference ||
      !this.config.bucket ||
      !this.config.region ||
      !this.config.kmsKeyRef
    )
      throw Error('independent staging fence disabled');
    if (this.testSend) return this.testSend(command);
    const c = new S3Client({
      region: this.config.region,
      endpoint: `https://s3.${this.config.region}.amazonaws.com`,
      credentials: this.credentials,
      maxAttempts: 1,
      followRegionRedirects: false,
    });
    try {
      return await c.send(command);
    } finally {
      c.destroy();
    }
  }
  private async load() {
    const r = await this.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: 'continuum/recovery/fence.json',
        ChecksumMode: 'ENABLED',
      }),
    );
    if (
      !r.ETag ||
      !r.Body ||
      (typeof r.ContentLength === 'number' && r.ContentLength > 4096)
    )
      throw Error('independent fence record missing/oversized');
    const bytes = await readLimitedBody(
      r.Body as AsyncIterable<Uint8Array>,
      4096,
    );
    const x = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (
      !Number.isSafeInteger(x.revision) ||
      x.revision < 1 ||
      typeof x.fence !== 'string' ||
      !x.fence ||
      typeof x.blocked !== 'boolean' ||
      !/^[0-9a-f]{64}$/.test(x.authorityDigest)
    )
      throw Error('invalid fence record');
    return { record: x as IndependentFence, etag: r.ETag as string };
  }
  async read() {
    return (await this.load()).record;
  }
  private async change(
    expected: number,
    fn: (x: IndependentFence) => IndependentFence,
  ) {
    const { record, etag } = await this.load();
    if (record.revision !== expected)
      throw Error('independent fence revision conflict');
    const next = fn(record);
    await this.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: 'continuum/recovery/fence.json',
        Body: canonical(next),
        IfMatch: etag,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyRef,
      }),
    );
    return next;
  }
  advance(expected: number, authorityDigest: string) {
    if (!/^[0-9a-f]{64}$/.test(authorityDigest))
      throw Error('authority journal digest');
    return this.change(expected, (x) => ({
      revision: x.revision + 1,
      fence: randomUUID(),
      blocked: true,
      authorityDigest,
    }));
  }
  async activate(expected: number, approvalDigest: string) {
    if (!/^[0-9a-f]{64}$/.test(approvalDigest))
      throw Error('approval manifest digest');
    await this.change(expected, (x) => {
      if (!x.blocked) throw Error('closed recovery required');
      return { ...x, revision: x.revision + 1, blocked: false, approvalDigest };
    });
  }
}
