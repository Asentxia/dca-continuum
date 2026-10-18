import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const secretField =
  /^(api[-_ ]?key|key|secret|token|credential|authorization|password)$/i;

export function rejectSecretFields(value: unknown): void {
  const walk = (current: unknown) => {
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (secretField.test(key)) throw Error('command secret rejected');
      walk(child);
    }
  };
  walk(value);
}

export function credentialKey(): Buffer {
  const raw = process.env.CT_MODEL_CREDENTIAL_KEK;
  if (!raw) throw Error('model credential key unavailable');
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw Error('model credential key unavailable');
  }
  if (key.length !== 32) throw Error('model credential key unavailable');
  return key;
}

export function sealCredential(plaintext: string) {
  if (!plaintext || plaintext.length > 512)
    throw Error('model credential rejected');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { nonce, ciphertext, keyVersion: 1 };
}

export function openCredential(sealed: {
  nonce: Buffer;
  ciphertext: Buffer;
  keyVersion: number;
}) {
  if (sealed.keyVersion !== 1 || sealed.nonce.length !== 12)
    throw Error('model credential unavailable');
  if (sealed.ciphertext.length <= 16)
    throw Error('model credential unavailable');
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    credentialKey(),
    sealed.nonce,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    'utf8',
  );
}
