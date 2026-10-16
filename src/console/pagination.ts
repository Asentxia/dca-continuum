import { createHmac, timingSafeEqual } from 'node:crypto';
export interface PageCursor {
  tenant: string;
  section: string;
  query: string;
  after: string;
  version: number;
}
export class CursorCodec {
  constructor(private key: Buffer) {
    if (key.length < 32) throw Error('cursor signing key required');
  }
  encode(value: PageCursor) {
    const b = Buffer.from(JSON.stringify(value)).toString('base64url');
    return (
      b + '.' + createHmac('sha256', this.key).update(b).digest('base64url')
    );
  }
  decode(token: string, expected: Omit<PageCursor, 'after'>) {
    if (token.length > 4096) throw Error('invalid cursor');
    const [b, s, extra] = token.split('.');
    if (extra || !b || !s) throw Error('invalid cursor');
    const actual = createHmac('sha256', this.key).update(b).digest(),
      sig = Buffer.from(s, 'base64url');
    if (sig.length !== actual.length || !timingSafeEqual(sig, actual))
      throw Error('invalid cursor');
    const v = JSON.parse(Buffer.from(b, 'base64url').toString());
    for (const k of ['tenant', 'section', 'query', 'version'] as const)
      if (v[k] !== expected[k]) throw Error('snapshot cursor conflict');
    if (typeof v.after !== 'string' || v.after.length > 256)
      throw Error('invalid cursor');
    return v as PageCursor;
  }
}
