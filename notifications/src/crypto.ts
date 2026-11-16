import crypto from 'node:crypto';

export interface EncryptedValue {
  ciphertext: string; // base64url encoded: iv(12) || tag(16) || encrypted
  keyId: string;
}

/**
 * AES-256-GCM authenticated encryption at rest for minimal PII (email, telegram chatId, webhook URL)
 * with versioned keyId support for zero-downtime key rotation, plus HMAC-SHA256 keyed lookup hashing.
 */
export class PiiCipher {
  private readonly activeKeyId: string;
  private readonly keys: Map<string, Buffer>;
  private readonly hashKey: Buffer;

  constructor(activeKeyId: string, keyRing: Record<string, string>, hashSecret: string) {
    this.keys = new Map();
    for (const [id, hexOrRaw] of Object.entries(keyRing)) {
      const cleanHex = hexOrRaw.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
        throw new Error(`Encryption key "${id}" must be a 64-character hex string (32 bytes for AES-256-GCM)`);
      }
      this.keys.set(id, Buffer.from(cleanHex, 'hex'));
    }
    if (!this.keys.has(activeKeyId)) {
      throw new Error(`Active ENCRYPTION_KEY_ID "${activeKeyId}" is missing from ENCRYPTION_KEYS`);
    }
    this.activeKeyId = activeKeyId;
    if (hashSecret.trim().length < 16) {
      throw new Error('PII_HASH_SECRET must be at least 16 characters');
    }
    this.hashKey = crypto.createHash('sha256').update(hashSecret, 'utf8').digest();
  }

  encrypt(plaintext: string): EncryptedValue {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, enc]).toString('base64url');
    return { ciphertext: packed, keyId: this.activeKeyId };
  }

  decrypt(ciphertext: string, keyId: string): string {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`Unknown encryption key id "${keyId}"`);
    }
    const raw = Buffer.from(ciphertext, 'base64url');
    if (raw.length < 28) {
      throw new Error('Corrupted ciphertext');
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  computeTargetHash(wallet: string, channel: string, normalizedTarget: string): string {
    return crypto
      .createHmac('sha256', this.hashKey)
      .update(`${wallet.toLowerCase()}|${channel}|${normalizedTarget}`)
      .digest('hex');
  }
}

export function maskTarget(channel: 'email' | 'telegram' | 'webhook', plaintext: string): string {
  if (channel === 'email') {
    const at = plaintext.indexOf('@');
    if (at <= 1) return '***';
    return `${plaintext.slice(0, 2)}***${plaintext.slice(at)}`;
  }
  if (channel === 'telegram') {
    if (plaintext.length <= 4) return '***';
    return `***${plaintext.slice(-4)}`;
  }
  try {
    const u = new URL(plaintext);
    return `${u.protocol}//${u.host}/***`;
  } catch {
    return 'https://***';
  }
}

interface UnsubPayload {
  p: 'unsubscribe';
  subId: string;
  wallet: string;
  exp: number;
}

export function signUnsubscribeToken(
  secret: string,
  subId: string,
  wallet: string,
  ttlSecs = 30 * 86_400,
  nowMs = Date.now()
): string {
  const payload: UnsubPayload = {
    p: 'unsubscribe',
    subId,
    wallet: wallet.toLowerCase(),
    exp: Math.floor(nowMs / 1000) + ttlSecs,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyUnsubscribeToken(
  secret: string,
  token: string,
  nowMs = Date.now()
): { subId: string; wallet: string } {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid unsubscribe token format');
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid unsubscribe token signature');
  }
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<UnsubPayload>;
  if (parsed.p !== 'unsubscribe' || typeof parsed.subId !== 'string' || typeof parsed.wallet !== 'string') {
    throw new Error('Invalid unsubscribe token purpose');
  }
  if (typeof parsed.exp !== 'number' || Math.floor(nowMs / 1000) > parsed.exp) {
    throw new Error('Unsubscribe token expired');
  }
  return { subId: parsed.subId, wallet: parsed.wallet };
}

interface SessionPayload {
  p: 'session';
  wallet: string;
  exp: number;
}

export function signSessionToken(
  secret: string,
  wallet: string,
  ttlSecs: number,
  nowMs = Date.now()
): { token: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + ttlSecs;
  const payload: SessionPayload = {
    p: 'session',
    wallet,
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifySessionToken(secret: string, token: string, nowMs = Date.now()): string {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid session token');
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid session token signature');
  }
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionPayload>;
  if (parsed.p !== 'session' || typeof parsed.wallet !== 'string') {
    throw new Error('Invalid session token purpose');
  }
  if (typeof parsed.exp !== 'number' || Math.floor(nowMs / 1000) > parsed.exp) {
    throw new Error('Session token expired');
  }
  return parsed.wallet;
}
