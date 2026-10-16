const sensitive =
  /(?:password|credential|secret|authorization|token|cookie|private.?key|^jwt$|^e2$|^receipt_?id$)/i;
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[Depth limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return value;
  if (typeof value === 'string') {
    if (
      /-----BEGIN .*PRIVATE KEY-----/.test(value) ||
      /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/.test(
        value,
      ) ||
      /(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{16,}/.test(value)
    )
      return '[Sensitive value omitted]';
    return value.slice(0, 32768);
  }
  if (Array.isArray(value))
    return value.slice(0, 200).map((x) => redact(x, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as any)
        .slice(0, 100)
        .map(([k, v]) => [
          k,
          sensitive.test(k) ? '[Redacted]' : redact(v, depth + 1),
        ]),
    );
  }
  return null;
}
export function requiresRedaction(value: unknown) {
  return JSON.stringify(redact(value)) !== JSON.stringify(value);
}
