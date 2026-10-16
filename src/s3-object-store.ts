import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { readLimitedBody } from './bounded-body.js';
import {
  bytesHash,
  safeObjectKey,
  type ImmutableObjectStore,
} from './object-store.js';
export interface S3StageConfig {
  enabled: boolean;
  approvalReference: string;
  region: string;
  bucket: string;
  kmsKeyRef: string;
  erasurePolicy?: 'verified-unversioned-disposable-stage';
}
export interface StagingAwsCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
export class S3ObjectStore implements ImmutableObjectStore {
  constructor(
    private config: S3StageConfig,
    private credentials: () => Promise<StagingAwsCredential>,
    private testSend?: (command: any) => Promise<any>,
  ) {}
  private async send(command: any) {
    if (
      !this.config.enabled ||
      !this.config.approvalReference ||
      !this.config.region ||
      !this.config.bucket ||
      !this.config.kmsKeyRef
    )
      throw Error('object-storage staging disabled/unapproved');
    if (this.testSend) return this.testSend(command);
    const client = new S3Client({
      region: this.config.region,
      endpoint: `https://s3.${this.config.region}.amazonaws.com`,
      credentials: this.credentials,
      maxAttempts: 1,
      followRegionRedirects: false,
    });
    try {
      return await client.send(command);
    } finally {
      client.destroy();
    }
  }
  async putIfAbsent(key: string, data: Uint8Array) {
    safeObjectKey(key);
    try {
      await this.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: data,
          IfNoneMatch: '*',
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.config.kmsKeyRef,
          ChecksumSHA256: Buffer.from(bytesHash(data), 'hex').toString(
            'base64',
          ),
        }),
      );
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode !== 412) throw e;
      if (bytesHash(await this.get(key)) !== bytesHash(data))
        throw Error('immutable cloud object conflict');
    }
  }
  async get(key: string) {
    safeObjectKey(key);
    const r = await this.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ChecksumMode: 'ENABLED',
      }),
    );
    if (
      !r.Body ||
      (typeof r.ContentLength === 'number' && r.ContentLength > 16777216)
    )
      throw Error('cloud object missing/too large');
    const b = await readLimitedBody(
      r.Body as AsyncIterable<Uint8Array>,
      16777216,
    );
    return new Uint8Array(b);
  }
  async erase(key: string) {
    if (this.config.erasurePolicy !== 'verified-unversioned-disposable-stage')
      throw Error('cloud physical erasure/retention not qualified');
    safeObjectKey(key);
    await this.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
}
