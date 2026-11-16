import crypto from 'node:crypto';
import { type Address, type Chain, type Hex, type PublicClient, type Transport, getAddress, isAddress } from 'viem';
import type { NotificationsConfig } from './config.js';
import type { NotifDatabase } from './db.js';

export interface ParsedSiweMessage {
  domain: string;
  address: Address;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export function formatSiweMessage(params: {
  domain: string;
  address: Address;
  statement?: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}): string {
  const lines = [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    getAddress(params.address),
    '',
    params.statement ?? 'Authenticate with NOSTOK Notifications.',
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expirationTime}`,
  ];
  return lines.join('\n');
}

export function parseSiweMessage(message: string): ParsedSiweMessage {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 7) {
    throw new Error('Malformed SIWE message');
  }
  const headerMatch = lines[0].match(/^(.+) wants you to sign in with your Ethereum account:$/);
  if (!headerMatch) {
    throw new Error('Invalid SIWE header line');
  }
  const domain = headerMatch[1].trim();
  const addrRaw = lines[1].trim();
  if (!isAddress(addrRaw) || getAddress(addrRaw) !== addrRaw) {
    throw new Error('SIWE address must be EIP-55 checksummed');
  }

  let uri: string | undefined;
  let version: string | undefined;
  let chainId: number | undefined;
  let nonce: string | undefined;
  let issuedAt: string | undefined;
  let expirationTime: string | undefined;

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('URI: ')) uri = line.slice('URI: '.length).trim();
    else if (line.startsWith('Version: ')) version = line.slice('Version: '.length).trim();
    else if (line.startsWith('Chain ID: ')) chainId = Number(line.slice('Chain ID: '.length).trim());
    else if (line.startsWith('Nonce: ')) nonce = line.slice('Nonce: '.length).trim();
    else if (line.startsWith('Issued At: ')) issuedAt = line.slice('Issued At: '.length).trim();
    else if (line.startsWith('Expiration Time: ')) expirationTime = line.slice('Expiration Time: '.length).trim();
  }

  if (!uri || version !== '1' || !Number.isInteger(chainId) || !nonce || !issuedAt || !expirationTime) {
    throw new Error('Missing required SIWE fields (URI, Version=1, Chain ID, Nonce, Issued At, Expiration Time)');
  }

  return {
    domain,
    address: getAddress(addrRaw),
    uri,
    version,
    chainId: chainId!,
    nonce,
    issuedAt,
    expirationTime,
  };
}

export async function issueSiweNonce(
  db: NotifDatabase,
  wallet: Address,
  config: Pick<NotificationsConfig, 'siweDomain' | 'siweNonceTtlSecs'>,
  nowMs = Date.now()
): Promise<{ nonce: string; expiresAt: string }> {
  const checksummed = getAddress(wallet);
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAtSec = Math.floor(nowMs / 1000) + config.siweNonceTtlSecs;

  await db.query(
    `INSERT INTO notif_nonces (nonce, wallet, domain, expires_at, used)
     VALUES ($1, $2, $3, $4, FALSE)`,
    [nonce, checksummed.toLowerCase(), config.siweDomain, expiresAtSec.toString()]
  );

  // Opportunistic cleanup of expired nonces so table stays bounded
  await db.query(
    'DELETE FROM notif_nonces WHERE expires_at < $1',
    [(Math.floor(nowMs / 1000) - 3600).toString()]
  );

  return { nonce, expiresAt: new Date(expiresAtSec * 1000).toISOString() };
}

/**
 * Verifies EIP-4361 SIWE message claims, atomic single-use server nonce, timestamps, and
 * EOA / EIP-1271 signature via viem's publicClient.verifyMessage.
 */
export async function verifySiweAuth(
  publicClient: PublicClient<Transport, Chain>,
  db: NotifDatabase,
  config: Pick<NotificationsConfig, 'siweDomain' | 'siweUri' | 'isFork' | 'forkChainId'>,
  message: string,
  signature: Hex,
  nowMs = Date.now()
): Promise<Address> {
  const parsed = parseSiweMessage(message);

  if (parsed.domain !== config.siweDomain) {
    throw new Error(`SIWE domain mismatch (expected ${config.siweDomain})`);
  }
  const expectedUriOrigin = new URL(config.siweUri).origin;
  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(parsed.uri).origin;
  } catch {
    throw new Error('Malformed SIWE URI');
  }
  if (parsedOrigin !== expectedUriOrigin) {
    throw new Error(`SIWE URI origin mismatch (expected ${expectedUriOrigin})`);
  }

  const expectedChainId = config.isFork ? config.forkChainId : 8453;
  if (parsed.chainId !== expectedChainId) {
    throw new Error(`SIWE chainId mismatch (expected ${expectedChainId})`);
  }

  const issuedMs = Date.parse(parsed.issuedAt);
  const expMs = Date.parse(parsed.expirationTime);
  if (Number.isNaN(issuedMs) || Number.isNaN(expMs)) {
    throw new Error('Invalid SIWE timestamps');
  }
  if (issuedMs > nowMs + 60_000) {
    throw new Error('SIWE Issued At is in the future');
  }
  if (nowMs > expMs) {
    throw new Error('SIWE message expired');
  }

  // Verify cryptographic signature first (supports both EOA ECDSA and ERC-1271 smart wallets)
  const sigValid = await publicClient.verifyMessage({
    address: parsed.address,
    message,
    signature,
  });
  if (!sigValid) {
    throw new Error('Invalid SIWE signature');
  }

  // Consume nonce atomically (single-use) only after signature passes, or validate ownership + expiry inside tx
  const nowSec = Math.floor(nowMs / 1000);
  await db.transaction(async (tx) => {
    const res = await tx.query<{
      wallet: string;
      domain: string;
      expires_at: string;
      used: boolean;
    }>('SELECT wallet, domain, expires_at::TEXT AS expires_at, used FROM notif_nonces WHERE nonce = $1', [
      parsed.nonce,
    ]);
    if (res.rows.length === 0) {
      throw new Error('Unknown SIWE nonce');
    }
    const row = res.rows[0];
    if (row.used) {
      throw new Error('SIWE nonce has already been used');
    }
    if (row.wallet.toLowerCase() !== parsed.address.toLowerCase() || row.domain !== config.siweDomain) {
      throw new Error('SIWE nonce is bound to a different wallet or domain');
    }
    if (nowSec > Number(row.expires_at)) {
      throw new Error('SIWE nonce expired');
    }
    const upd = await tx.query<{ nonce: string }>(
      'UPDATE notif_nonces SET used = TRUE WHERE nonce = $1 AND used = FALSE RETURNING nonce',
      [parsed.nonce]
    );
    if (upd.rows.length === 0) {
      throw new Error('SIWE nonce already consumed');
    }
  });

  return parsed.address;
}
