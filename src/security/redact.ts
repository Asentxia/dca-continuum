const sensitive =
  /token|secret|password|authorization|cookie|credential|private.?key/i;
/** Never serialize opaque identity/task credentials or arbitrary exception contents. */
export function redactLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH_LIMIT]';
  if (value instanceof Error)
    return { name: value.name, detail: '[ERROR_DETAIL_REDACTED]' };
  if (value instanceof Uint8Array) return '[BINARY_REDACTED]';
  if (Array.isArray(value))
    return value.slice(0, 100).map((x) => redactLog(x, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          key,
          sensitive.test(key) ? '[REDACTED]' : redactLog(item, depth + 1),
        ]),
    );
  if (typeof value === 'string') {
    const scrubbed = value
      .replace(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
        '[TOKEN_REDACTED]',
      )
      .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[TOKEN_REDACTED]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, '[TOKEN_REDACTED]');
    return scrubbed.slice(0, 4096);
  }
  return value;
}
