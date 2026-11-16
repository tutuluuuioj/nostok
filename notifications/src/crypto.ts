import crypto from 'node:crypto';

export interface EncryptedValue {
  ciphertext: string; // base64url encoded: iv(12) || tag(16) || encrypted
  keyId: string;
}

export function computeShannonEntropyBitsPerChar(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const cnt of counts.values()) {
    const p = cnt / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function assertSecretEntropy(
  secret: string,
  name: string,
  opts: { minLen?: number; minUnique?: number; minEntropyBits?: number } = {}
): string {
  const clean = secret.trim();
  const minLen = opts.minLen ?? 24;
  const minUnique = opts.minUnique ?? 8;
  const minEntropyBits = opts.minEntropyBits ?? 2.8;

  if (clean.length < minLen) {
    throw new Error(`${name} is too short (min length ${minLen})`);
  }
  const uniqueChars = new Set(clean.split('')).size;
  const entropy = computeShannonEntropyBitsPerChar(clean);
  if (uniqueChars < minUnique || entropy < minEntropyBits) {
    throw new Error(
      `${name} has insufficient entropy (unique=${uniqueChars}, entropy=${entropy.toFixed(2)} bits/char)`
    );
  }
  return clean;
}

export function assertDistinctSecrets(namedSecrets: Record<string, string>): void {
  const seen = new Map<string, string>();
  for (const [name, rawVal] of Object.entries(namedSecrets)) {
    const val = rawVal.trim();
    if (!val) continue;
    const prev = seen.get(val);
    if (prev) {
      throw new Error(`Secrets must be distinct: ${name} cannot share the same value as ${prev}`);
    }
    seen.set(val, name);
  }
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
      assertSecretEntropy(cleanHex.toLowerCase(), `ENCRYPTION_KEYS[${id}]`, {
        minLen: 64,
        minUnique: 8,
        minEntropyBits: 2.8,
      });
      this.keys.set(id, Buffer.from(cleanHex, 'hex'));
    }
    if (!this.keys.has(activeKeyId)) {
      throw new Error(`Active ENCRYPTION_KEY_ID "${activeKeyId}" is missing from ENCRYPTION_KEYS`);
    }
    this.activeKeyId = activeKeyId;
    assertSecretEntropy(hashSecret, 'PII_HASH_SECRET', {
      minLen: 24,
      minUnique: 8,
      minEntropyBits: 2.8,
    });
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

  computeGlobalTargetHash(channel: string, normalizedTarget: string): string {
    const canonical = canonicalizeTargetForRateLimit(channel, normalizedTarget);
    return crypto
      .createHmac('sha256', this.hashKey)
      .update(`global|${channel}|${canonical}`)
      .digest('hex');
  }
}

export function canonicalizeTargetForRateLimit(channel: string, normalizedTarget: string): string {
  const trimmed = normalizedTarget.trim();
  if (channel === 'email') {
    const lower = trimmed.toLowerCase();
    const atIdx = lower.lastIndexOf('@');
    if (atIdx > 0) {
      const local = lower.slice(0, atIdx).replace(/\+.*$/, '');
      const domain = lower.slice(atIdx + 1);
      return `${local}@${domain}`;
    }
    return lower;
  }
  return trimmed;
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
  jti: string;
  wallet: string;
  iat: number;
  exp: number;
}

export interface VerifiedSessionClaims {
  wallet: string;
  jti: string;
  exp: number;
}

export function signSessionToken(
  secret: string,
  wallet: string,
  ttlSecs: number,
  nowMs = Date.now()
): { token: string; jti: string; expiresAt: string; exp: number } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSecs;
  const jti = crypto.randomUUID();
  const payload: SessionPayload = {
    p: 'session',
    jti,
    wallet,
    iat,
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, jti, expiresAt: new Date(exp * 1000).toISOString(), exp };
}

export function verifySessionTokenClaims(
  secret: string,
  token: string,
  nowMs = Date.now()
): VerifiedSessionClaims {
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
  if (
    parsed.p !== 'session' ||
    typeof parsed.wallet !== 'string' ||
    typeof parsed.jti !== 'string' ||
    parsed.jti.length < 8
  ) {
    throw new Error('Invalid session token purpose or missing jti');
  }
  if (typeof parsed.exp !== 'number' || Math.floor(nowMs / 1000) > parsed.exp) {
    throw new Error('Session token expired');
  }
  return { wallet: parsed.wallet, jti: parsed.jti, exp: parsed.exp };
}

export function verifySessionToken(secret: string, token: string, nowMs = Date.now()): string {
  return verifySessionTokenClaims(secret, token, nowMs).wallet;
}

interface ConfirmSubPayload {
  p: 'confirm_sub';
  subId: string;
  wallet: string;
  codeHash: string;
  exp: number;
}

export function hashVerificationCode(
  confirmSecret: string,
  subId: string,
  wallet: string,
  code: string
): string {
  return crypto
    .createHmac('sha256', confirmSecret)
    .update(`${wallet.toLowerCase()}|${subId}|${code.trim()}`, 'utf8')
    .digest('hex');
}

export function signConfirmSubscriptionToken(
  secret: string,
  subId: string,
  wallet: string,
  codeHash: string,
  ttlSecs = 3600,
  nowMs = Date.now()
): string {
  const payload: ConfirmSubPayload = {
    p: 'confirm_sub',
    subId,
    wallet: wallet.toLowerCase(),
    codeHash,
    exp: Math.floor(nowMs / 1000) + ttlSecs,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyConfirmSubscriptionToken(
  secret: string,
  token: string,
  nowMs = Date.now()
): { subId: string; wallet: string; codeHash: string } {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid confirmation token format');
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid confirmation token signature');
  }
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<ConfirmSubPayload>;
  if (
    parsed.p !== 'confirm_sub' ||
    typeof parsed.subId !== 'string' ||
    typeof parsed.wallet !== 'string' ||
    typeof parsed.codeHash !== 'string'
  ) {
    throw new Error('Invalid confirmation token purpose');
  }
  if (typeof parsed.exp !== 'number' || Math.floor(nowMs / 1000) > parsed.exp) {
    throw new Error('Confirmation token expired');
  }
  return { subId: parsed.subId, wallet: parsed.wallet, codeHash: parsed.codeHash };
}

export function signWebhookPayload(
  secret: string,
  timestampSec: number,
  rawBody: string
): { timestampHeader: string; signatureHeader: string; mac: string } {
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${timestampSec}.${rawBody}`, 'utf8')
    .digest('hex');
  return {
    timestampHeader: String(timestampSec),
    signatureHeader: `t=${timestampSec},v1=${mac}`,
    mac,
  };
}

export function verifyWebhookPayloadSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300
): boolean {
  const parts = new Map<string, string>();
  for (const part of signatureHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    parts.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  const tsStr = parts.get('t');
  const sigHex = parts.get('v1');
  if (!tsStr || !sigHex || !/^\d+$/.test(tsStr) || !/^[0-9a-fA-F]{64}$/.test(sigHex)) {
    return false;
  }
  const ts = Number(tsStr);
  if (Math.abs(nowSec - ts) > toleranceSec) {
    return false;
  }
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`, 'utf8')
    .digest('hex');
  const a = Buffer.from(sigHex.toLowerCase(), 'utf8');
  const b = Buffer.from(expectedHex.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
