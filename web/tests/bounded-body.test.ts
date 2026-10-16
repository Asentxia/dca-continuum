import { it, expect } from 'vitest';
import { boundedJson } from '../lib/bounded-body';
function input(bytes: Uint8Array, length?: string) {
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });
  return {
    headers: new Headers(length ? { 'content-length': length } : {}),
    body,
  };
}
it('bounded JSON preserves exact UTF-8 payload', async () =>
  expect(
    await boundedJson(
      input(new TextEncoder().encode('{"value":"Δ exact"}')),
      200,
    ),
  ).toEqual({ value: 'Δ exact' }));
it('declared oversized or invalid length is rejected', async () => {
  for (const length of ['999999', 'not-a-length'])
    await expect(
      boundedJson(input(new TextEncoder().encode('{}'), length), 200),
    ).rejects.toThrow();
});
it('undeclared oversized stream is rejected before JSON allocation', async () =>
  await expect(
    boundedJson(input(new Uint8Array(32769)), 32768),
  ).rejects.toThrow('limit'));
it('malformed UTF-8 cannot alter immutable command content', async () =>
  await expect(
    boundedJson(
      input(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])),
      200,
    ),
  ).rejects.toThrow());
