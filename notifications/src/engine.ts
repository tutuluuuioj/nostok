import crypto from 'node:crypto';
import {
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  createPublicClient,
  defineChain,
  getAddress,
  http as viemHttp,
} from 'viem';
import { base } from 'viem/chains';
import {
  OracleState,
  assetRegistryAbi,
  loanCoreAbi,
  oracleRouterAbi,
} from './abi.js';
import {
  type ChannelTransports,
  type DnsLookupFn,
  type NotificationChannel,
  type WebhookHttpRequester,
  createDefaultTransports,
  defaultDnsLookup,
} from './channels.js';
import type { NotificationsConfig } from './config.js';
import { PiiCipher, signUnsubscribeToken } from './crypto.js';
import {
  type NotifDatabase,
  type ReadOnlyIndexerDatabase,
  openNotifDatabase,
  openReadOnlyIndexerDatabase,
} from './db.js';
import { ALL_ALERT_TYPES, type AlertType } from './validation.js';

export interface NotificationCandidate {
  wallet: string; // lowercase hex
  alertType: AlertType;
  severity: 'info' | 'warning' | 'critical';
  criticalOverride: boolean;
  dedupKey: string;
  title: string;
  message: string;
  payload: Record<string, unknown>;
}

export interface CircuitBreakerEntry {
  consecutiveFailures: number;
  openUntilMs: number;
}

export interface NotificationsContext {
  config: NotificationsConfig;
  publicClient: PublicClient<Transport, Chain>;
  indexerDb: ReadOnlyIndexerDatabase;
  notifDb: NotifDatabase;
  cipher: PiiCipher;
  transports: ChannelTransports;
  dnsLookup: DnsLookupFn;
  state: {
    cycleCount: number;
    lastSyncTimestamp: string | null;
    lastError: string | null;
    lastRiskFetchOk: boolean;
    circuitBreakers: Map<string, CircuitBreakerEntry>;
  };
}

export interface SyncCycleStats {
  enqueued: number;
  sent: number;
  retried: number;
  deadLettered: number;
  suppressedQuiet: number;
  suppressedRateLimit: number;
}

const CRITICAL_OVERRIDE_TYPES = new Set<AlertType>([
  'liquidation_started',
  'auction_settled',
  'maturity_reminder_6h',
  'default_auction_pending',
  'asset_frozen_or_corporate_action',
]);

const GRACE_PERIOD_SECS = 86_400n;
const HYSTERESIS_BPS = 200;
const MULTICALL_CHUNK_SIZE = 100;
const MULTICALL_FALLBACK_CONCURRENCY = 8;
const BACKOFF_MULTIPLIERS = [1, 5, 30, 120, 240, 480];
const STATEFUL_ALERT_TYPES = new Set<AlertType>([
  'loan_margin_call',
  'loan_near_liquidation',
  'oracle_stale',
  'asset_frozen_or_corporate_action',
  'maturity_reminder_3d',
  'maturity_reminder_1d',
  'maturity_reminder_6h',
  'loan_grace_entry',
  'penalty_interest_accruing',
  'default_auction_pending',
]);

async function chunkedMulticall(
  publicClient: PublicClient<Transport, Chain>,
  contracts: ReadonlyArray<{
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }>,
  chunkSize = MULTICALL_CHUNK_SIZE
): Promise<Array<{ status: 'success'; result: unknown } | { status: 'failure'; error: unknown }>> {
  const out: Array<{ status: 'success'; result: unknown } | { status: 'failure'; error: unknown }> = [];
  for (let start = 0; start < contracts.length; start += chunkSize) {
    const chunk = contracts.slice(start, start + chunkSize);
    try {
      const res = await publicClient.multicall({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contracts: chunk as any,
        allowFailure: true,
      });
      for (const r of res) {
        if (r.status === 'success') out.push({ status: 'success', result: r.result });
        else out.push({ status: 'failure', error: r.error });
      }
    } catch {
      const chunkResults: Array<
        { status: 'success'; result: unknown } | { status: 'failure'; error: unknown }
      > = new Array(chunk.length);
      let idx = 0;
      const workerCount = Math.min(MULTICALL_FALLBACK_CONCURRENCY, chunk.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (idx < chunk.length) {
            const cur = idx++;
            const c = chunk[cur];
            try {
              const result = await publicClient.readContract({
                address: c.address,
                abi: c.abi,
                functionName: c.functionName,
                args: c.args,
              } as Parameters<typeof publicClient.readContract>[0]);
              chunkResults[cur] = { status: 'success', result };
            } catch (error) {
              chunkResults[cur] = { status: 'failure', error };
            }
          }
        })
      );
      out.push(...chunkResults);
    }
  }
  return out;
}

async function runWithSendTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Delivery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateChainId(chainId: number, cfg: Pick<NotificationsConfig, 'isFork' | 'forkChainId'>): void {
  if (!cfg.isFork && chainId !== 8453) {
    throw new Error(`Invalid chainId ${chainId}: expected 8453`);
  }
  if (cfg.isFork && chainId !== cfg.forkChainId) {
    throw new Error(`Invalid fork chainId ${chainId}: expected ${cfg.forkChainId}`);
  }
}

export async function createNotificationsContext(
  config: NotificationsConfig,
  opts: {
    indexerDbOverride?: ReadOnlyIndexerDatabase;
    notifDbOverride?: NotifDatabase;
    transportsOverride?: ChannelTransports;
    cipherOverride?: PiiCipher;
    dnsLookupOverride?: DnsLookupFn;
    webhookRequesterOverride?: WebhookHttpRequester;
  } = {}
): Promise<NotificationsContext> {
  const probeClient = createPublicClient({ transport: viemHttp(config.rpcUrl), cacheTime: 0 });
  const chainId = await probeClient.getChainId();
  validateChainId(chainId, config);

  const chain = defineChain({
    id: chainId,
    name: chainId === base.id ? base.name : `Nostok Chain ${chainId}`,
    nativeCurrency: base.nativeCurrency,
    contracts: chainId === base.id ? base.contracts : undefined,
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const publicClient = createPublicClient({
    chain,
    transport: viemHttp(config.rpcUrl),
    cacheTime: 0,
  });

  const indexerDb =
    opts.indexerDbOverride ?? (await openReadOnlyIndexerDatabase(config.indexerDatabaseUrl));
  const notifDb = opts.notifDbOverride ?? (await openNotifDatabase(config.databaseUrl));
  const cipher =
    opts.cipherOverride ??
    new PiiCipher(config.encryptionKeyId, config.encryptionKeys, config.piiHashSecret);
  const dnsLookup = opts.dnsLookupOverride ?? defaultDnsLookup;
  const transports =
    opts.transportsOverride ??
    createDefaultTransports({
      smtpApiUrl: config.smtpApiUrl,
      smtpApiKey: config.smtpApiKey,
      emailFrom: config.emailFrom,
      telegramBotToken: config.telegramBotToken,
      telegramApiBase: config.telegramApiBase,
      outboundTimeoutMs: config.outboundTimeoutMs,
      webhookSigningSecret: config.webhookSigningSecret,
      dnsLookup,
      webhookRequester: opts.webhookRequesterOverride,
    });

  return {
    config,
    publicClient,
    indexerDb,
    notifDb,
    cipher,
    transports,
    dnsLookup,
    state: {
      cycleCount: 0,
      lastSyncTimestamp: null,
      lastError: null,
      lastRiskFetchOk: false,
      circuitBreakers: new Map(),
    },
  };
}

export function isWithinQuietHours(
  nowUtcHour: number,
  startHour: number | null,
  endHour: number | null
): boolean {
  if (startHour === null || endHour === null) return false;
  if (startHour === endHour) return false;
  if (startHour < endHour) {
    return nowUtcHour >= startHour && nowUtcHour < endHour;
  }
  return nowUtcHour >= startHour || nowUtcHour < endHour;
}

interface RiskLoanApiRow {
  loan_id: string;
  borrower: string;
  collateral_token: string;
  risk_status: 'healthy' | 'margin_call' | 'near_liquidation' | 'liquidatable';
  current_ltv_bps: number;
  margin_call_ltv_bps?: number;
  liq_ltv_bps?: number;
  loan_status?: number;
  oracle_state: number;
  oracle_state_name: string;
  block_number: string;
}

interface RiskAlertApiRow {
  dedup_key: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  message: string;
  details: Record<string, unknown>;
}

async function fetchRiskMonitorState(ctx: NotificationsContext): Promise<{
  loans: RiskLoanApiRow[];
  alerts: RiskAlertApiRow[];
} | null> {
  if (!ctx.config.riskApiUrl) return null;
  try {
    const loans: RiskLoanApiRow[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const rLoans = await fetch(
        `${ctx.config.riskApiUrl}/risk/loans?limit=100&offset=${offset}`,
        { signal: AbortSignal.timeout(ctx.config.outboundTimeoutMs) }
      );
      if (!rLoans.ok) throw new Error(`Risk /risk/loans HTTP ${rLoans.status}`);
      const json = (await rLoans.json()) as {
        data: RiskLoanApiRow[];
        pagination?: { has_more?: boolean; next_cursor?: string | null };
      };
      loans.push(...(json.data ?? []));
      if (!json.pagination?.has_more) break;
      offset += 100;
    }

    const rAlerts = await fetch(
      `${ctx.config.riskApiUrl}/risk/alerts?status=active&limit=100`,
      { signal: AbortSignal.timeout(ctx.config.outboundTimeoutMs) }
    );
    if (!rAlerts.ok) throw new Error(`Risk /risk/alerts HTTP ${rAlerts.status}`);
    const alertsJson = (await rAlerts.json()) as { data: RiskAlertApiRow[] };
    ctx.state.lastRiskFetchOk = true;
    return { loans, alerts: alertsJson.data ?? [] };
  } catch (err) {
    ctx.state.lastRiskFetchOk = false;
    console.warn(
      `[NOTIF_RISK_FALLBACK] Unable to query Risk API, falling back to direct on-chain view state: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

function parseEventPayload(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown;
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

async function resolveEpisodeKey(
  db: NotifDatabase,
  stateKey: string,
  isTriggered: boolean,
  shouldClear: boolean,
  currentValueBps: number | null,
  nowMs: number,
  clearDampingMs = 0
): Promise<string | null> {
  const existing = await db.query<{
    active: boolean;
    episode: number;
    clear_since: string | null;
  }>(
    'SELECT active, episode, clear_since::TEXT AS clear_since FROM notif_alert_episodes WHERE state_key = $1',
    [stateKey]
  );
  const row = existing.rows[0];
  const wasActive = row?.active ?? false;
  const prevEpisode = Number(row?.episode ?? 0);

  if (isTriggered) {
    if (!wasActive) {
      const nextEpisode = prevEpisode + 1;
      await db.query(
        `INSERT INTO notif_alert_episodes (state_key, active, episode, last_value_bps, clear_since, updated_at)
         VALUES ($1, TRUE, $2, $3, NULL, $4)
         ON CONFLICT (state_key) DO UPDATE SET
           active = TRUE,
           episode = EXCLUDED.episode,
           last_value_bps = EXCLUDED.last_value_bps,
           clear_since = NULL,
           updated_at = EXCLUDED.updated_at`,
        [stateKey, nextEpisode, currentValueBps, nowMs.toString()]
      );
      return `${stateKey}:ep:${nextEpisode}`;
    }
    await db.query(
      `UPDATE notif_alert_episodes
       SET last_value_bps = $2, clear_since = NULL, updated_at = $3
       WHERE state_key = $1`,
      [stateKey, currentValueBps, nowMs.toString()]
    );
    return `${stateKey}:ep:${prevEpisode}`;
  }

  if (shouldClear && wasActive) {
    if (clearDampingMs > 0) {
      const clearSinceMs =
        row?.clear_since !== null && row?.clear_since !== undefined ? Number(row.clear_since) : null;
      if (clearSinceMs === null) {
        await db.query(
          `UPDATE notif_alert_episodes
           SET clear_since = $2, last_value_bps = $3, updated_at = $2
           WHERE state_key = $1`,
          [stateKey, nowMs.toString(), currentValueBps]
        );
        return null;
      }
      if (nowMs - clearSinceMs < clearDampingMs) {
        await db.query(
          `UPDATE notif_alert_episodes
           SET last_value_bps = $2, updated_at = $3
           WHERE state_key = $1`,
          [stateKey, currentValueBps, nowMs.toString()]
        );
        return null;
      }
    }
    await db.query(
      `UPDATE notif_alert_episodes
       SET active = FALSE, last_value_bps = $2, clear_since = NULL, updated_at = $3
       WHERE state_key = $1`,
      [stateKey, currentValueBps, nowMs.toString()]
    );
  }
  return null;
}

interface OnchainLoanSnapshot {
  borrower: Address;
  collateralToken: Address;
  collateralRaw: bigint;
  principal: bigint;
  maturity: bigint;
  penaltySpreadBps: number;
  marginCallLtvBps: number;
  liqLtvBps: number;
  status: number;
  principalRepaid: bigint;
}

export async function runNotificationsCycle(
  ctx: NotificationsContext,
  nowMs = Date.now()
): Promise<SyncCycleStats> {
  ctx.state.cycleCount += 1;
  ctx.state.lastSyncTimestamp = new Date(nowMs).toISOString();

  // 1. Identify verified, enabled subscribed wallets and preferences
  const [subRows, prefRows, cursorRes] = await Promise.all([
    ctx.notifDb.query<{
      id: string;
      wallet: string;
      channel: NotificationChannel;
      target_ciphertext: string;
      key_id: string;
    }>(
      `SELECT id, wallet, channel, target_ciphertext, key_id
       FROM notif_subscriptions
       WHERE enabled = TRUE AND verified = TRUE`
    ),
    ctx.notifDb.query<{
      wallet: string;
      alert_types_json: string;
      quiet_hours_start: number | null;
      quiet_hours_end: number | null;
      max_per_hour: number;
    }>(
      `SELECT wallet, alert_types_json, quiet_hours_start, quiet_hours_end, max_per_hour
       FROM notif_preferences`
    ),
    ctx.notifDb.query<{ last_event_id: string }>(
      'SELECT last_event_id::TEXT AS last_event_id FROM notif_cursor WHERE id = 1'
    ),
  ]);

  const subsByWallet = new Map<string, typeof subRows.rows>();
  for (const s of subRows.rows) {
    const w = s.wallet.toLowerCase();
    const arr = subsByWallet.get(w) ?? [];
    arr.push(s);
    subsByWallet.set(w, arr);
  }
  const subscribedWallets = Array.from(subsByWallet.keys());
  const prefByWallet = new Map(prefRows.rows.map((p) => [p.wallet.toLowerCase(), p]));
  const lastEventId = cursorRes.rows.length > 0 ? BigInt(cursorRes.rows[0].last_event_id) : 0n;

  const candidates: NotificationCandidate[] = [];
  let maxProcessedEventId = lastEventId;

  if (subscribedWallets.length > 0) {
    // 2. Read open loans, auctions, assets, and new events strictly via SELECT-only queries
    const [openLoansRes, allAuctionsRes, eventsRes, assetsRes, riskState, latestBlock] = await Promise.all([
      ctx.indexerDb.query<{
        loan_id: string;
        borrower: string;
        lender: string | null;
        nft_owner: string | null;
        collateral_token: string;
        maturity: string;
        status: number;
      }>(
        `SELECT
           l.loan_id::TEXT AS loan_id,
           l.borrower,
           l.lender,
           p.owner AS nft_owner,
           l.collateral_token,
           l.maturity::TEXT AS maturity,
           l.status
         FROM loans l
         LEFT JOIN positions p ON p.loan_id = l.loan_id AND p.is_burned = FALSE
         WHERE l.status IN (0, 1, 2)`
      ),
      ctx.indexerDb.query<{
        auction_id: string;
        loan_id: string;
        borrower: string;
        lender: string | null;
        nft_owner: string | null;
      }>(
        `SELECT
           a.auction_id::TEXT AS auction_id,
           a.loan_id::TEXT AS loan_id,
           l.borrower,
           l.lender,
           p.owner AS nft_owner
         FROM auctions a
         JOIN loans l ON l.loan_id = a.loan_id
         LEFT JOIN positions p ON p.loan_id = l.loan_id AND p.is_burned = FALSE`
      ),
      ctx.indexerDb.query<{
        id: string;
        block_number: string;
        event_name: string;
        loan_id: string | null;
        token: string | null;
        actor: string | null;
        counterparty: string | null;
        amount_raw: string | null;
        secondary_amount: string | null;
        payload: unknown;
        borrower: string | null;
        lender: string | null;
        nft_owner: string | null;
        collateral_token: string | null;
      }>(
        `SELECT
           e.id::TEXT AS id,
           e.block_number::TEXT AS block_number,
           e.event_name,
           e.loan_id::TEXT AS loan_id,
           e.token,
           e.actor,
           e.counterparty,
           e.amount_raw::TEXT AS amount_raw,
           e.secondary_amount::TEXT AS secondary_amount,
           e.payload,
           l.borrower,
           l.lender,
           p.owner AS nft_owner,
           l.collateral_token
         FROM loan_events e
         LEFT JOIN loans l ON l.loan_id = e.loan_id
         LEFT JOIN positions p ON p.loan_id = e.loan_id AND p.is_burned = FALSE
         WHERE e.id > $1
         ORDER BY e.id ASC
         LIMIT 500`,
        [lastEventId.toString()]
      ),
      ctx.indexerDb.query<{ token: string; symbol: string | null; decimals: number | null }>(
        'SELECT token, symbol, decimals FROM assets'
      ),
      fetchRiskMonitorState(ctx),
      ctx.publicClient.getBlock(),
    ]);

    const symbolByToken = new Map(
      assetsRes.rows.map((a) => [a.token.toLowerCase(), a.symbol ?? a.token])
    );
    const assetDecMap = new Map(
      assetsRes.rows.map((a) => [a.token.toLowerCase(), a.decimals !== null ? Number(a.decimals) : 18])
    );
    const auctionMetaById = new Map(
      allAuctionsRes.rows.map((a) => [a.auction_id, a])
    );

    // Fetch live on-chain loan & due interest via bounded chunked multicall (re-verifies repaid loans)
    const onchainByLoanId = new Map<string, { loan: OnchainLoanSnapshot; dueInt: bigint }>();
    if (openLoansRes.rows.length > 0) {
      const loanContracts = openLoansRes.rows.flatMap((loan) => [
        {
          address: ctx.config.loanCore,
          abi: loanCoreAbi,
          functionName: 'getLoan',
          args: [BigInt(loan.loan_id)],
        } as const,
        {
          address: ctx.config.loanCore,
          abi: loanCoreAbi,
          functionName: 'getDueInterest',
          args: [BigInt(loan.loan_id)],
        } as const,
      ]);
      const loanMcRes = await chunkedMulticall(ctx.publicClient, loanContracts);
      for (let i = 0; i < openLoansRes.rows.length; i++) {
        const loan = openLoansRes.rows[i];
        const loanRes = loanMcRes[i * 2];
        const dueRes = loanMcRes[i * 2 + 1];
        if (!loanRes || !dueRes || loanRes.status !== 'success' || dueRes.status !== 'success') {
          console.warn(`[NOTIF_ONCHAIN_LOAN_WARN] Loan #${loan.loan_id}: multicall read failed`);
          continue;
        }
        const onchainLoan = loanRes.result as {
          borrower: Address;
          collateralToken: Address;
          collateralRaw: bigint;
          principal: bigint;
          maturity: bigint;
          penaltySpreadBps: number | bigint;
          marginCallLtvBps: number | bigint;
          liqLtvBps: number | bigint;
          status: number | bigint;
          principalRepaid: bigint;
        };
        onchainByLoanId.set(loan.loan_id, {
          loan: {
            borrower: onchainLoan.borrower,
            collateralToken: onchainLoan.collateralToken,
            collateralRaw: onchainLoan.collateralRaw,
            principal: onchainLoan.principal,
            maturity: onchainLoan.maturity,
            penaltySpreadBps: Number(onchainLoan.penaltySpreadBps),
            marginCallLtvBps: Number(onchainLoan.marginCallLtvBps),
            liqLtvBps: Number(onchainLoan.liqLtvBps),
            status: Number(onchainLoan.status),
            principalRepaid: onchainLoan.principalRepaid,
          },
          dueInt: dueRes.result as bigint,
        });
      }
    }

    // Build set of genuinely open loans by asset (excluding loans already repaid/closed on-chain)
    const openLoansByAsset = new Map<
      string,
      Array<{ loan_id: string; borrower: string; lender: string | null }>
    >();
    const activeOpenLoanIds = new Set<string>();
    for (const loan of openLoansRes.rows) {
      const oc = onchainByLoanId.get(loan.loan_id);
      if (oc) {
        const principalRem =
          oc.loan.principal > oc.loan.principalRepaid
            ? oc.loan.principal - oc.loan.principalRepaid
            : 0n;
        if (oc.loan.status >= 3 || principalRem === 0n || oc.loan.collateralRaw === 0n) {
          // Clear open-loan alert episodes for loans already closed on-chain
          await resolveEpisodeKey(ctx.notifDb, `margin_call:${loan.loan_id}`, false, true, 0, nowMs);
          await resolveEpisodeKey(ctx.notifDb, `near_liq:${loan.loan_id}`, false, true, 0, nowMs);
          await resolveEpisodeKey(
            ctx.notifDb,
            `oracle_stale:${loan.collateral_token.toLowerCase()}:${loan.loan_id}`,
            false,
            true,
            null,
            nowMs
          );
          await resolveEpisodeKey(
            ctx.notifDb,
            `asset_frozen:${loan.collateral_token.toLowerCase()}:${loan.loan_id}`,
            false,
            true,
            null,
            nowMs
          );
          continue;
        }
      }
      activeOpenLoanIds.add(loan.loan_id);
      const tok = loan.collateral_token.toLowerCase();
      const holder = (loan.nft_owner ?? loan.lender)?.toLowerCase() ?? null;
      const arr = openLoansByAsset.get(tok) ?? [];
      arr.push({ loan_id: loan.loan_id, borrower: loan.borrower.toLowerCase(), lender: holder });
      openLoansByAsset.set(tok, arr);
    }

    // 3. Process chronological events from indexer (liquidation started/restarted, bid, settled, repaid, claimable)
    for (const ev of eventsRes.rows) {
      const eid = BigInt(ev.id);
      if (eid > maxProcessedEventId) maxProcessedEventId = eid;

      const pl = parseEventPayload(ev.payload);
      let resolvedLoanId = ev.loan_id;
      let borrower = ev.borrower?.toLowerCase() ?? null;
      let lenderHolder = (ev.nft_owner ?? ev.lender)?.toLowerCase() ?? null;

      if ((!resolvedLoanId || !borrower) && pl.auctionId !== undefined) {
        const aMeta = auctionMetaById.get(String(pl.auctionId));
        if (aMeta) {
          resolvedLoanId = aMeta.loan_id;
          borrower = aMeta.borrower.toLowerCase();
          lenderHolder = (aMeta.nft_owner ?? aMeta.lender)?.toLowerCase() ?? null;
        }
      }

      const recipients = new Set<string>();
      if (borrower && subsByWallet.has(borrower)) recipients.add(borrower);
      if (lenderHolder && subsByWallet.has(lenderHolder)) recipients.add(lenderHolder);

      if (ev.event_name === 'AuctionStarted') {
        const auctionIdStr = pl.auctionId !== undefined ? String(pl.auctionId) : ev.id;
        for (const wallet of recipients) {
          candidates.push({
            wallet,
            alertType: 'liquidation_started',
            severity: 'critical',
            criticalOverride: true,
            dedupKey: `liquidation_started:${resolvedLoanId ?? '0'}:auction:${auctionIdStr}:block:${ev.block_number}`,
            title: `Liquidation started on Loan #${resolvedLoanId ?? '?'}`,
            message: `Loan #${resolvedLoanId ?? '?'} entered liquidation auction #${auctionIdStr} at block ${ev.block_number}.`,
            payload: {
              loan_id: resolvedLoanId,
              auction_id: auctionIdStr,
              event_id: ev.id,
              block_number: ev.block_number,
            },
          });
        }
      } else if (ev.event_name === 'AuctionRestarted') {
        const auctionIdStr = pl.auctionId !== undefined ? String(pl.auctionId) : ev.id;
        for (const wallet of recipients) {
          candidates.push({
            wallet,
            alertType: 'liquidation_started',
            severity: 'critical',
            criticalOverride: true,
            dedupKey: `liquidation_started:${resolvedLoanId ?? '0'}:restarted:${auctionIdStr}:block:${ev.block_number}:${ev.id}`,
            title: `Liquidation auction restarted on Loan #${resolvedLoanId ?? '?'}`,
            message: `Liquidation auction #${auctionIdStr} for Loan #${resolvedLoanId ?? '?'} restarted at block ${ev.block_number}.`,
            payload: {
              loan_id: resolvedLoanId,
              auction_id: auctionIdStr,
              event_id: ev.id,
              block_number: ev.block_number,
              restarted: true,
            },
          });
        }
      } else if (ev.event_name === 'AuctionBought') {
        for (const wallet of recipients) {
          candidates.push({
            wallet,
            alertType: 'auction_bid',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `auction_bid:${ev.id}`,
            title: `Auction bid filled on Loan #${resolvedLoanId ?? '?'}`,
            message: `Auction fill executed (${ev.secondary_amount ?? '0'} USDC raw) for Loan #${resolvedLoanId ?? '?'}.`,
            payload: {
              loan_id: resolvedLoanId,
              event_id: ev.id,
              usdc_paid_raw: ev.secondary_amount,
              collateral_bought_raw: ev.amount_raw,
            },
          });
        }
      } else if (ev.event_name === 'AuctionSettled') {
        for (const wallet of recipients) {
          candidates.push({
            wallet,
            alertType: 'auction_settled',
            severity: 'critical',
            criticalOverride: true,
            dedupKey: `auction_settled:${resolvedLoanId ?? ev.id}`,
            title: `Auction settled on Loan #${resolvedLoanId ?? '?'}`,
            message: `Auction settled for Loan #${resolvedLoanId ?? '?'} (total USDC ${ev.amount_raw ?? '0'} raw).`,
            payload: { loan_id: resolvedLoanId, event_id: ev.id, total_usdc_raw: ev.amount_raw },
          });
        }
        if (lenderHolder && subsByWallet.has(lenderHolder)) {
          candidates.push({
            wallet: lenderHolder,
            alertType: 'lender_claimable',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `lender_claimable:settled:${resolvedLoanId ?? ev.id}`,
            title: `Claimable funds available for Loan #${resolvedLoanId ?? '?'}`,
            message: `Settlement proceeds from Loan #${resolvedLoanId ?? '?'} can now be claimed via LoanCore.claim().`,
            payload: { loan_id: resolvedLoanId, event_id: ev.id },
          });
        }
      } else if (ev.event_name === 'AuctionCancelled') {
        const auctionIdStr = pl.auctionId !== undefined ? String(pl.auctionId) : ev.id;
        for (const wallet of recipients) {
          candidates.push({
            wallet,
            alertType: 'auction_cancelled',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: `auction_cancelled:${resolvedLoanId ?? '0'}:auction:${auctionIdStr}:block:${ev.block_number}:${ev.id}`,
            title: `Auction cancelled on Loan #${resolvedLoanId ?? '?'}`,
            message: `Liquidation auction #${auctionIdStr} for Loan #${resolvedLoanId ?? '?'} was cancelled at block ${ev.block_number}.`,
            payload: {
              loan_id: resolvedLoanId,
              auction_id: auctionIdStr,
              event_id: ev.id,
              block_number: ev.block_number,
            },
          });
        }
      } else if (ev.event_name === 'Repaid' || ev.event_name === 'PartialRepaid') {
        for (const wallet of recipients) {
          candidates.push({
            wallet,
            alertType: 'loan_repaid',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `loan_repaid:${ev.event_name}:${ev.id}`,
            title:
              ev.event_name === 'Repaid'
                ? `Loan #${resolvedLoanId ?? '?'} repaid in full`
                : `Partial repayment on Loan #${resolvedLoanId ?? '?'}`,
            message: `Repayment recorded on Loan #${resolvedLoanId ?? '?'} (principal=${ev.amount_raw ?? '0'} raw).`,
            payload: {
              loan_id: resolvedLoanId,
              event_name: ev.event_name,
              principal_paid_raw: ev.amount_raw,
            },
          });
        }
        if (lenderHolder && subsByWallet.has(lenderHolder)) {
          candidates.push({
            wallet: lenderHolder,
            alertType: 'lender_claimable',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `lender_claimable:repay:${ev.id}`,
            title: `Lender claimable funds from Loan #${resolvedLoanId ?? '?'}`,
            message: `Repayment on Loan #${resolvedLoanId ?? '?'} added claimable USDC to your lender balance.`,
            payload: { loan_id: resolvedLoanId, event_id: ev.id },
          });
        }
      }
    }

    // 4. Risk state & episode-based dedup with 200 bps hysteresis
    const seenStaleAssetLoan = new Set<string>();
    const seenFrozenAssetLoan = new Set<string>();

    if (riskState) {
      for (const rl of riskState.loans) {
        const oc = onchainByLoanId.get(rl.loan_id);
        if (oc && (oc.loan.status >= 3 || oc.loan.principal <= oc.loan.principalRepaid)) {
          continue;
        }
        const borrower = rl.borrower.toLowerCase();
        if (!subsByWallet.has(borrower)) continue;

        const marginCallLtvBps = oc?.loan.marginCallLtvBps ?? rl.margin_call_ltv_bps ?? 7000;
        const liqLtvBps = oc?.loan.liqLtvBps ?? rl.liq_ltv_bps ?? 7800;
        const nearThresh = Math.max(marginCallLtvBps, liqLtvBps - 300);
        const ltvBps = rl.current_ltv_bps;

        const inMarginBand = rl.risk_status === 'margin_call';
        const clearMargin = ltvBps <= marginCallLtvBps - HYSTERESIS_BPS;
        const mcDedup = await resolveEpisodeKey(
          ctx.notifDb,
          `margin_call:${rl.loan_id}`,
          inMarginBand,
          clearMargin,
          ltvBps,
          nowMs
        );
        if (mcDedup) {
          candidates.push({
            wallet: borrower,
            alertType: 'loan_margin_call',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: mcDedup,
            title: `Margin call on Loan #${rl.loan_id}`,
            message: `Loan #${rl.loan_id} LTV reached ${ltvBps} bps. Add collateral or repay to lower risk.`,
            payload: { loan_id: rl.loan_id, current_ltv_bps: ltvBps },
          });
        }

        const inNearOrLiq = rl.risk_status === 'near_liquidation' || rl.risk_status === 'liquidatable';
        const clearNear = ltvBps <= nearThresh - HYSTERESIS_BPS;
        const nearDedup = await resolveEpisodeKey(
          ctx.notifDb,
          `near_liq:${rl.loan_id}`,
          inNearOrLiq,
          clearNear,
          ltvBps,
          nowMs
        );
        if (nearDedup) {
          candidates.push({
            wallet: borrower,
            alertType: 'loan_near_liquidation',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: nearDedup,
            title: `Loan #${rl.loan_id} near liquidation`,
            message: `Loan #${rl.loan_id} LTV is ${ltvBps} bps (status=${rl.risk_status}). Immediate action advised.`,
            payload: {
              loan_id: rl.loan_id,
              current_ltv_bps: ltvBps,
              risk_status: rl.risk_status,
            },
          });
        }
      }

      for (const ra of riskState.alerts) {
        if (ra.category === 'keeper' && ra.dedup_key.startsWith('keeper_inactive:default:')) {
          const defLoanId = ra.dedup_key.slice('keeper_inactive:default:'.length);
          const loanRow = openLoansRes.rows.find((l) => l.loan_id === defLoanId);
          const oc = onchainByLoanId.get(defLoanId);
          if (loanRow && (!oc || (oc.loan.status < 3 && oc.loan.principal > oc.loan.principalRepaid))) {
            const b = loanRow.borrower.toLowerCase();
            const h = (loanRow.nft_owner ?? loanRow.lender)?.toLowerCase() ?? null;
            for (const w of [b, h]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'default_auction_pending',
                severity: 'critical',
                criticalOverride: true,
                dedupKey: `default_auction_pending:${defLoanId}:${loanRow.maturity}`,
                title: `Default auction pending on Loan #${defLoanId}`,
                message: `Loan #${defLoanId} passed maturity + 24h grace period without full repayment and awaits default auction.`,
                payload: { loan_id: defLoanId, maturity: loanRow.maturity },
              });
            }
          }
          continue;
        }

        const tok = typeof ra.details?.token === 'string' ? ra.details.token.toLowerCase() : null;
        if (!tok) continue;
        const sym = symbolByToken.get(tok) ?? tok;
        const affected = openLoansByAsset.get(tok) ?? [];

        if (
          ra.category === 'corporate_action' ||
          (ra.category === 'asset_status' && ra.dedup_key.endsWith(':frozen'))
        ) {
          for (const entry of affected) {
            const stateKey = `asset_frozen:${tok}:${entry.loan_id}`;
            seenFrozenAssetLoan.add(stateKey);
            const dedupKey = await resolveEpisodeKey(ctx.notifDb, stateKey, true, false, null, nowMs);
            if (!dedupKey) continue;
            for (const w of [entry.borrower, entry.lender]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'asset_frozen_or_corporate_action',
                severity: 'critical',
                criticalOverride: true,
                dedupKey,
                title: `${sym} corporate action / frozen notice (Loan #${entry.loan_id})`,
                message: ra.message,
                payload: { loan_id: entry.loan_id, token: tok, alert_key: ra.dedup_key },
              });
            }
          }
        } else if (ra.category === 'oracle' && ra.dedup_key.startsWith('oracle_stale:')) {
          for (const entry of affected) {
            const stateKey = `oracle_stale:${tok}:${entry.loan_id}`;
            seenStaleAssetLoan.add(stateKey);
            const dedupKey = await resolveEpisodeKey(ctx.notifDb, stateKey, true, false, null, nowMs);
            if (!dedupKey) continue;
            for (const w of [entry.borrower, entry.lender]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'oracle_stale',
                severity: 'warning',
                criticalOverride: false,
                dedupKey,
                title: `Oracle stale notice for ${sym} (Loan #${entry.loan_id})`,
                message: ra.message,
                payload: { loan_id: entry.loan_id, token: tok },
              });
            }
          }
        }
      }

      // Clear stale / frozen episodes for open loans when riskState no longer reports those alerts (with clear damping)
      for (const [tok, affected] of openLoansByAsset.entries()) {
        for (const entry of affected) {
          const staleKey = `oracle_stale:${tok}:${entry.loan_id}`;
          if (!seenStaleAssetLoan.has(staleKey)) {
            await resolveEpisodeKey(
              ctx.notifDb,
              staleKey,
              false,
              true,
              null,
              nowMs,
              ctx.config.episodeClearDampingMs
            );
          }
          const frozenKey = `asset_frozen:${tok}:${entry.loan_id}`;
          if (!seenFrozenAssetLoan.has(frozenKey)) {
            await resolveEpisodeKey(
              ctx.notifDb,
              frozenKey,
              false,
              true,
              null,
              nowMs,
              ctx.config.episodeClearDampingMs
            );
          }
        }
      }
    } else {
      // On-chain read-only fallback when RISK_API_URL is omitted/unreachable (chunked per unique token)
      const fallbackTokens = Array.from(openLoansByAsset.keys()).map((t) => getAddress(t));
      const assetStateByToken = new Map<
        string,
        { oPrice: bigint; oDec: number; oState: number; aStatus: number }
      >();
      if (fallbackTokens.length > 0) {
        const fallbackAssetContracts = fallbackTokens.flatMap((tokenAddr) => [
          {
            address: ctx.config.oracleRouter,
            abi: oracleRouterAbi,
            functionName: 'getPrice',
            args: [tokenAddr],
          } as const,
          {
            address: ctx.config.assetRegistry,
            abi: assetRegistryAbi,
            functionName: 'getAssetConfig',
            args: [tokenAddr],
          } as const,
        ]);
        const assetMcRes = await chunkedMulticall(ctx.publicClient, fallbackAssetContracts);
        for (let i = 0; i < fallbackTokens.length; i++) {
          const pRes = assetMcRes[i * 2];
          const cRes = assetMcRes[i * 2 + 1];
          if (pRes?.status === 'success' && cRes?.status === 'success') {
            const pr = pRes.result as readonly [bigint, number, number];
            const cfg = cRes.result as { status: number };
            assetStateByToken.set(fallbackTokens[i].toLowerCase(), {
              oPrice: pr[0],
              oDec: Number(pr[1]),
              oState: Number(pr[2]),
              aStatus: Number(cfg.status),
            });
          }
        }
      }

      for (const l of openLoansRes.rows) {
        if (!activeOpenLoanIds.has(l.loan_id)) continue;
        const oc = onchainByLoanId.get(l.loan_id);
        if (!oc || oc.loan.status >= 2) continue;

        const tok = l.collateral_token.toLowerCase();
        const assetState = assetStateByToken.get(tok);
        if (!assetState) continue;

        const borrower = l.borrower.toLowerCase();
        const holder = (l.nft_owner ?? l.lender)?.toLowerCase() ?? null;
        try {
          const sym = symbolByToken.get(tok) ?? l.collateral_token;
          const { oPrice, oDec, oState, aStatus } = assetState;

          const isFrozen = oState === OracleState.FROZEN_CORPORATE_ACTION || aStatus === 3;
          const frozenDedup = await resolveEpisodeKey(
            ctx.notifDb,
            `asset_frozen:${tok}:${l.loan_id}`,
            isFrozen,
            !isFrozen,
            null,
            nowMs,
            ctx.config.episodeClearDampingMs
          );
          if (frozenDedup) {
            for (const w of [borrower, holder]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'asset_frozen_or_corporate_action',
                severity: 'critical',
                criticalOverride: true,
                dedupKey: frozenDedup,
                title: `${sym} corporate action / frozen notice (Loan #${l.loan_id})`,
                message: `${sym} collateral has oracle state ${oState} / AssetStatus ${aStatus}.`,
                payload: { loan_id: l.loan_id, token: tok, oracle_state: oState, asset_status: aStatus },
              });
            }
          }

          const isStale = oState === OracleState.STALE_FEED;
          const staleDedup = await resolveEpisodeKey(
            ctx.notifDb,
            `oracle_stale:${tok}:${l.loan_id}`,
            isStale,
            !isStale,
            null,
            nowMs,
            ctx.config.episodeClearDampingMs
          );
          if (staleDedup) {
            for (const w of [borrower, holder]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'oracle_stale',
                severity: 'warning',
                criticalOverride: false,
                dedupKey: staleDedup,
                title: `Oracle stale notice for ${sym} (Loan #${l.loan_id})`,
                message: `Oracle price feed for ${sym} is STALE_FEED.`,
                payload: { loan_id: l.loan_id, token: tok },
              });
            }
          }

          if (subsByWallet.has(borrower) && oc.loan.status < 2) {
            const dec = assetDecMap.get(tok) ?? 18;
            const scale = 10n ** BigInt(dec) * 10n ** BigInt(oDec);
            const grossUsdc =
              oc.loan.collateralRaw > 0n && oPrice > 0n
                ? (oc.loan.collateralRaw * oPrice * 1_000_000n) / scale
                : 0n;
            const principalRem =
              oc.loan.principal > oc.loan.principalRepaid
                ? oc.loan.principal - oc.loan.principalRepaid
                : 0n;
            const totalDebt = principalRem + oc.dueInt;
            const ltvBps = grossUsdc > 0n ? Number((totalDebt * 10_000n) / grossUsdc) : 100_000;
            const nearThresh = Math.max(oc.loan.marginCallLtvBps, oc.loan.liqLtvBps - 300);

            const mcDedup = await resolveEpisodeKey(
              ctx.notifDb,
              `margin_call:${l.loan_id}`,
              ltvBps >= oc.loan.marginCallLtvBps && ltvBps < nearThresh,
              ltvBps <= oc.loan.marginCallLtvBps - HYSTERESIS_BPS,
              ltvBps,
              nowMs
            );
            if (mcDedup) {
              candidates.push({
                wallet: borrower,
                alertType: 'loan_margin_call',
                severity: 'warning',
                criticalOverride: false,
                dedupKey: mcDedup,
                title: `Margin call on Loan #${l.loan_id}`,
                message: `Loan #${l.loan_id} LTV reached ${ltvBps} bps.`,
                payload: { loan_id: l.loan_id, current_ltv_bps: ltvBps },
              });
            }

            const nearDedup = await resolveEpisodeKey(
              ctx.notifDb,
              `near_liq:${l.loan_id}`,
              ltvBps >= nearThresh,
              ltvBps <= nearThresh - HYSTERESIS_BPS,
              ltvBps,
              nowMs
            );
            if (nearDedup) {
              candidates.push({
                wallet: borrower,
                alertType: 'loan_near_liquidation',
                severity: 'warning',
                criticalOverride: false,
                dedupKey: nearDedup,
                title: `Loan #${l.loan_id} near liquidation`,
                message: `Loan #${l.loan_id} LTV is ${ltvBps} bps (liq threshold=${oc.loan.liqLtvBps} bps).`,
                payload: { loan_id: l.loan_id, current_ltv_bps: ltvBps },
              });
            }
          }
        } catch (err) {
          console.warn(
            `[NOTIF_ONCHAIN_READ_WARN] Loan #${l.loan_id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 5. Maturity reminders (re-checked strictly on-chain) & post-maturity grace/penalty/default alerts
    const blockTs = latestBlock.timestamp;
    for (const loan of openLoansRes.rows) {
      const oc = onchainByLoanId.get(loan.loan_id);
      if (!oc) continue; // Do not guess maturity/default alerts without verified on-chain status

      const onchainStatus = oc.loan.status;
      const principalRem =
        oc.loan.principal > oc.loan.principalRepaid
          ? oc.loan.principal - oc.loan.principalRepaid
          : 0n;
      if (onchainStatus >= 3 || principalRem === 0n || oc.loan.collateralRaw === 0n) {
        continue; // Repaid or settled on-chain even if indexer DB lags
      }

      const borrower = loan.borrower.toLowerCase();
      const holder = (loan.nft_owner ?? loan.lender)?.toLowerCase() ?? null;
      const maturity = oc.loan.maturity;

      if (onchainStatus === 0 && blockTs < maturity) {
        if (!subsByWallet.has(borrower)) continue;
        const secsLeft = Number(maturity - blockTs);
        if (secsLeft <= 21_600) {
          candidates.push({
            wallet: borrower,
            alertType: 'maturity_reminder_6h',
            severity: 'critical',
            criticalOverride: true,
            dedupKey: `maturity_6h:${loan.loan_id}:${maturity.toString()}`,
            title: `Urgent: Loan #${loan.loan_id} matures in < 6 hours`,
            message: `Loan #${loan.loan_id} reaches maturity in ${Math.max(1, Math.floor(secsLeft / 60))} minutes.`,
            payload: { loan_id: loan.loan_id, seconds_remaining: secsLeft, maturity: maturity.toString() },
          });
        } else if (secsLeft <= 86_400) {
          candidates.push({
            wallet: borrower,
            alertType: 'maturity_reminder_1d',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: `maturity_1d:${loan.loan_id}:${maturity.toString()}`,
            title: `Reminder: Loan #${loan.loan_id} matures in < 24 hours`,
            message: `Loan #${loan.loan_id} matures in ${Math.max(1, Math.floor(secsLeft / 3600))} hours.`,
            payload: { loan_id: loan.loan_id, seconds_remaining: secsLeft, maturity: maturity.toString() },
          });
        } else if (secsLeft <= 259_200) {
          candidates.push({
            wallet: borrower,
            alertType: 'maturity_reminder_3d',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: `maturity_3d:${loan.loan_id}:${maturity.toString()}`,
            title: `Reminder: Loan #${loan.loan_id} matures within 3 days`,
            message: `Loan #${loan.loan_id} matures in ${Math.max(1, Math.floor(secsLeft / 3600))} hours.`,
            payload: { loan_id: loan.loan_id, seconds_remaining: secsLeft, maturity: maturity.toString() },
          });
        }
      } else if ((onchainStatus === 0 || onchainStatus === 1) && blockTs > maturity) {
        // Post-maturity: Grace entry, penalty interest accruing, & default auction pending
        const overdueSecs = Number(blockTs - maturity);
        if (blockTs <= maturity + GRACE_PERIOD_SECS || onchainStatus === 1) {
          for (const w of [borrower, holder]) {
            if (!w || !subsByWallet.has(w)) continue;
            candidates.push({
              wallet: w,
              alertType: 'loan_grace_entry',
              severity: 'warning',
              criticalOverride: false,
              dedupKey: `loan_grace_entry:${loan.loan_id}:${maturity.toString()}`,
              title: `Loan #${loan.loan_id} entered post-maturity grace period`,
              message: `Loan #${loan.loan_id} passed maturity and entered its 24h grace window (${overdueSecs}s overdue).`,
              payload: { loan_id: loan.loan_id, overdue_seconds: overdueSecs, maturity: maturity.toString() },
            });
          }
        }
        if (subsByWallet.has(borrower)) {
          candidates.push({
            wallet: borrower,
            alertType: 'penalty_interest_accruing',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: `penalty_interest:${loan.loan_id}:${maturity.toString()}`,
            title: `Penalty interest accruing on overdue Loan #${loan.loan_id}`,
            message: `Loan #${loan.loan_id} is accruing overdue penalty interest (+${oc.loan.penaltySpreadBps} bps spread). Repay promptly to avoid default auction.`,
            payload: {
              loan_id: loan.loan_id,
              penalty_spread_bps: oc.loan.penaltySpreadBps,
              due_interest_raw: oc.dueInt.toString(),
              overdue_seconds: overdueSecs,
            },
          });
        }
        if (blockTs > maturity + GRACE_PERIOD_SECS) {
          for (const w of [borrower, holder]) {
            if (!w || !subsByWallet.has(w)) continue;
            candidates.push({
              wallet: w,
              alertType: 'default_auction_pending',
              severity: 'critical',
              criticalOverride: true,
              dedupKey: `default_auction_pending:${loan.loan_id}:${maturity.toString()}`,
              title: `Default auction pending on Loan #${loan.loan_id}`,
              message: `Loan #${loan.loan_id} exceeded maturity + 24h grace period (${overdueSecs}s overdue) and is eligible for default liquidation.`,
              payload: {
                loan_id: loan.loan_id,
                overdue_seconds: overdueSecs,
                maturity: maturity.toString(),
              },
            });
          }
        }
      }
    }

    // 6. Direct on-chain getClaimable balance check for subscribed wallets (chunked multicall)
    const claimWallets = Array.from(subscribedWallets);
    if (claimWallets.length > 0) {
      const claimContracts = claimWallets.map((w) => ({
        address: ctx.config.loanCore,
        abi: loanCoreAbi,
        functionName: 'getClaimable',
        args: [getAddress(w)],
      }));
      const claimRes = await chunkedMulticall(ctx.publicClient, claimContracts);
      for (let i = 0; i < claimWallets.length; i++) {
        const res = claimRes[i];
        if (res?.status !== 'success') continue;
        const amt = res.result as bigint;
        if (amt > 0n) {
          candidates.push({
            wallet: claimWallets[i],
            alertType: 'lender_claimable',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `lender_claimable:bal:${amt.toString()}`,
            title: 'USDC funds ready to claim',
            message: `You have ${amt.toString()} USDC (6 decimals) claimable in LoanCore.`,
            payload: { claimable_raw: amt.toString() },
          });
        }
      }
    }
  }

  // Track active stateful conditions in this cycle so stale/resolved suppressed alerts are not delivered later
  const activeCandidateDedupKeys = new Set(candidates.map((c) => c.dedupKey));

  // 7. Filter by preferences, dedup, quiet hours (critical override), per-user hourly rate limit (critical bypasses),
  //    re-queue suppressed rows when suppression clears (respecting cap & active state), and enqueue.
  let enqueued = 0;
  let suppressedQuiet = 0;
  let suppressedRateLimit = 0;
  const nowUtcHour = new Date(nowMs).getUTCHours();

  const batchSentCountByWallet = new Map<string, number>();

  async function getWalletSentLastHour(wallet: string): Promise<number> {
    const cached = batchSentCountByWallet.get(wallet);
    if (cached !== undefined) return cached;
    const rlRes = await ctx.notifDb.query<{ cnt: number }>(
      `SELECT COUNT(*)::INT AS cnt
       FROM notif_deliveries
       WHERE wallet = $1
         AND status IN ('sent', 'pending', 'retry', 'sending')
         AND COALESCE(sent_at, claimed_at, next_attempt_at, created_at) >= $2`,
      [wallet, (nowMs - 3_600_000).toString()]
    );
    const val = Number(rlRes.rows[0]?.cnt ?? 0);
    batchSentCountByWallet.set(wallet, val);
    return val;
  }

  for (const cand of candidates) {
    const subs = subsByWallet.get(cand.wallet);
    if (!subs || subs.length === 0) continue;

    const pref = prefByWallet.get(cand.wallet);
    let enabledTypes: Record<string, boolean> | null = null;
    if (pref?.alert_types_json) {
      try {
        enabledTypes = JSON.parse(pref.alert_types_json) as Record<string, boolean>;
      } catch {
        enabledTypes = null;
      }
    }
    if (enabledTypes && enabledTypes[cand.alertType] === false) {
      continue;
    }

    const quietActive =
      pref !== undefined &&
      isWithinQuietHours(nowUtcHour, pref.quiet_hours_start, pref.quiet_hours_end);
    const maxPerHour = pref?.max_per_hour ?? ctx.config.userRateLimitPerHour;
    let walletSentLastHour = await getWalletSentLastHour(cand.wallet);

    const isCritical = CRITICAL_OVERRIDE_TYPES.has(cand.alertType) || cand.criticalOverride;

    for (const sub of subs) {
      let initialStatus: string = 'pending';
      if (quietActive && !isCritical) {
        initialStatus = 'suppressed_quiet_hours';
      } else if (!isCritical && walletSentLastHour >= maxPerHour) {
        initialStatus = 'suppressed_rate_limit';
      }

      const id = `dlv_${crypto.randomUUID().replace(/-/g, '')}`;
      const ins = await ctx.notifDb.query<{ id: string; status: string }>(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $12)
         ON CONFLICT (subscription_id, dedup_key) DO UPDATE SET
           status = 'pending',
           title = EXCLUDED.title,
           message = EXCLUDED.message,
           payload_json = EXCLUDED.payload_json,
           next_attempt_at = EXCLUDED.next_attempt_at
         WHERE notif_deliveries.status IN ('suppressed_quiet_hours', 'suppressed_rate_limit')
           AND EXCLUDED.status = 'pending'
         RETURNING id, status`,
        [
          id,
          cand.wallet,
          sub.id,
          sub.channel,
          cand.alertType,
          cand.severity,
          cand.dedupKey,
          cand.title,
          cand.message,
          JSON.stringify(cand.payload),
          initialStatus,
          nowMs.toString(),
        ]
      );

      if (ins.rows.length > 0) {
        if (ins.rows[0].status === 'suppressed_quiet_hours') {
          suppressedQuiet++;
        } else if (ins.rows[0].status === 'suppressed_rate_limit') {
          suppressedRateLimit++;
        } else {
          enqueued++;
          walletSentLastHour++;
          batchSentCountByWallet.set(cand.wallet, walletSentLastHour);
        }
      }
    }
  }

  // 7b. Drain suppressed_quiet_hours (when quiet hours end) & suppressed_rate_limit (when hourly cap opens)
  for (const wallet of subscribedWallets) {
    const pref = prefByWallet.get(wallet);
    const quietActive =
      pref !== undefined &&
      isWithinQuietHours(nowUtcHour, pref.quiet_hours_start, pref.quiet_hours_end);

    let enabledTypes: Record<string, boolean> | null = null;
    if (pref?.alert_types_json) {
      try {
        enabledTypes = JSON.parse(pref.alert_types_json) as Record<string, boolean>;
      } catch {
        enabledTypes = null;
      }
    }

    const suppressedRes = await ctx.notifDb.query<{
      id: string;
      alert_type: AlertType;
      severity: 'info' | 'warning' | 'critical';
      dedup_key: string;
      status: string;
    }>(
      `SELECT id, alert_type, severity, dedup_key, status
       FROM notif_deliveries
       WHERE wallet = $1
         AND status IN ('suppressed_quiet_hours', 'suppressed_rate_limit')
       ORDER BY created_at ASC
       LIMIT 100`,
      [wallet]
    );
    if (suppressedRes.rows.length === 0) continue;

    const maxPerHour = pref?.max_per_hour ?? ctx.config.userRateLimitPerHour;
    let walletSentLastHour = await getWalletSentLastHour(wallet);
    for (const row of suppressedRes.rows) {
      if (row.status === 'suppressed_quiet_hours' && quietActive) {
        continue;
      }
      if (enabledTypes && enabledTypes[row.alert_type] === false) {
        await ctx.notifDb.query(
          `UPDATE notif_deliveries SET status = 'expired_cleared'
           WHERE id = $1 AND status IN ('suppressed_quiet_hours', 'suppressed_rate_limit')`,
          [row.id]
        );
        continue;
      }
      // Re-check whether a stateful condition is still active before draining delayed alerts
      if (STATEFUL_ALERT_TYPES.has(row.alert_type) && !activeCandidateDedupKeys.has(row.dedup_key)) {
        await ctx.notifDb.query(
          `UPDATE notif_deliveries SET status = 'expired_cleared'
           WHERE id = $1 AND status IN ('suppressed_quiet_hours', 'suppressed_rate_limit')`,
          [row.id]
        );
        continue;
      }

      const isCrit =
        row.severity === 'critical' || CRITICAL_OVERRIDE_TYPES.has(row.alert_type);
      if (!isCrit && walletSentLastHour >= maxPerHour) {
        if (row.status === 'suppressed_quiet_hours') {
          await ctx.notifDb.query(
            `UPDATE notif_deliveries SET status = 'suppressed_rate_limit'
             WHERE id = $1 AND status = 'suppressed_quiet_hours'`,
            [row.id]
          );
        }
        continue;
      }
      const upd = await ctx.notifDb.query<{ id: string }>(
        `UPDATE notif_deliveries
         SET status = 'pending', next_attempt_at = $2
         WHERE id = $1 AND status IN ('suppressed_quiet_hours', 'suppressed_rate_limit')
         RETURNING id`,
        [row.id, nowMs.toString()]
      );
      if (upd.rows.length > 0) {
        enqueued++;
        walletSentLastHour++;
        batchSentCountByWallet.set(wallet, walletSentLastHour);
      }
    }
  }

  // Advance event cursor cleanly
  if (maxProcessedEventId > lastEventId) {
    await ctx.notifDb.query(
      `INSERT INTO notif_cursor (id, last_event_id, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_event_id = EXCLUDED.last_event_id, updated_at = NOW()`,
      [maxProcessedEventId.toString()]
    );
  }

  // 8. Dispatch due pending & retry deliveries (FOR UPDATE SKIP LOCKED + decrypt catch + circuit breaker + DLQ)
  const dispatchStats = await processDeliveryQueue(ctx, nowMs);

  return {
    enqueued,
    sent: dispatchStats.sent,
    retried: dispatchStats.retried,
    deadLettered: dispatchStats.deadLettered,
    suppressedQuiet,
    suppressedRateLimit,
  };
}

type ClaimedDeliveryRow = {
  id: string;
  wallet: string;
  subscription_id: string;
  channel: NotificationChannel;
  alert_type: string;
  severity: 'info' | 'warning' | 'critical';
  dedup_key: string;
  title: string;
  message: string;
  payload_json: string;
  attempts: number;
  target_ciphertext: string;
  key_id: string;
  sub_enabled: boolean;
  sub_verified: boolean;
};

async function moveToDeadLetter(
  db: NotifDatabase,
  row: ClaimedDeliveryRow,
  attempts: number,
  nowMs: number
): Promise<void> {
  const dlqId = `dlq_${crypto.randomUUID().replace(/-/g, '')}`;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE notif_deliveries
       SET status = 'dead_letter', attempts = $2, claimed_at = NULL, lease_until = NULL, last_error = 'delivery failed'
       WHERE id = $1`,
      [row.id, attempts]
    );
    await tx.query(
      `INSERT INTO notif_dead_letters (
         id, delivery_id, wallet, subscription_id, channel, alert_type, dedup_key,
         payload_json, attempts, last_error, failed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'delivery failed', $10)`,
      [
        dlqId,
        row.id,
        row.wallet,
        row.subscription_id,
        row.channel,
        row.alert_type,
        row.dedup_key,
        row.payload_json,
        attempts,
        nowMs.toString(),
      ]
    );
  });
}

function buildCircuitHostKey(
  channel: NotificationChannel,
  decryptedTarget: string,
  config: Pick<NotificationsConfig, 'smtpApiUrl' | 'telegramApiBase'>
): string {
  if (channel === 'webhook') {
    try {
      return `webhook:${new URL(decryptedTarget).host.toLowerCase()}`;
    } catch {
      return 'webhook:invalid-host';
    }
  }
  if (channel === 'email') {
    let smtpHost = 'default-smtp';
    if (config.smtpApiUrl) {
      try {
        smtpHost = new URL(config.smtpApiUrl).host.toLowerCase();
      } catch {
        smtpHost = 'invalid-smtp';
      }
    }
    const atIdx = decryptedTarget.lastIndexOf('@');
    const recipientDomain =
      atIdx >= 0 ? decryptedTarget.slice(atIdx + 1).toLowerCase() : 'default-domain';
    return `email:${smtpHost}:${recipientDomain}`;
  }
  let tgHost = 'api.telegram.org';
  try {
    tgHost = new URL(config.telegramApiBase).host.toLowerCase();
  } catch {
    tgHost = 'invalid-telegram';
  }
  return `telegram:${tgHost}:${decryptedTarget}`;
}

export async function processDeliveryQueue(
  ctx: NotificationsContext,
  nowMs = Date.now()
): Promise<{ sent: number; retried: number; deadLettered: number }> {
  const claimed = await ctx.notifDb.transaction(async (tx) => {
    // Reclaim stuck 'sending' rows whose lease expired after a worker crash
    await tx.query(
      `UPDATE notif_deliveries
       SET status = 'retry', next_attempt_at = $1, claimed_at = NULL, lease_until = NULL, last_error = 'sending lease expired'
       WHERE status = 'sending' AND (lease_until IS NULL OR lease_until <= $1)`,
      [nowMs.toString()]
    );

    const sel = await tx.query<ClaimedDeliveryRow>(
      `SELECT
         d.id, d.wallet, d.subscription_id, d.channel, d.alert_type, d.severity, d.dedup_key,
         d.title, d.message, d.payload_json, d.attempts,
         s.target_ciphertext, s.key_id, s.enabled AS sub_enabled, s.verified AS sub_verified
       FROM notif_deliveries d
       JOIN notif_subscriptions s ON s.id = d.subscription_id
       WHERE d.status IN ('pending', 'retry') AND d.next_attempt_at <= $1
       ORDER BY d.created_at ASC
       LIMIT 100
       FOR UPDATE OF d SKIP LOCKED`,
      [nowMs.toString()]
    );
    const leaseUntil = (nowMs + ctx.config.sendingLeaseMs).toString();
    for (const r of sel.rows) {
      await tx.query(
        "UPDATE notif_deliveries SET status = 'sending', claimed_at = $2, lease_until = $3 WHERE id = $1",
        [r.id, nowMs.toString(), leaseUntil]
      );
    }
    return sel.rows;
  });

  let sent = 0;
  let retried = 0;
  let deadLettered = 0;
  let nextIdx = 0;

  async function processOne(row: ClaimedDeliveryRow): Promise<void> {
    if (!row.sub_enabled || !row.sub_verified) {
      await ctx.notifDb.query(
        "UPDATE notif_deliveries SET status = 'unsubscribed', claimed_at = NULL, lease_until = NULL WHERE id = $1",
        [row.id]
      );
      return;
    }

    let decryptedTarget: string;
    try {
      decryptedTarget = ctx.cipher.decrypt(row.target_ciphertext, row.key_id);
    } catch (err) {
      console.warn(
        `[NOTIF_DECRYPT_WARN] Unable to decrypt subscription ${row.subscription_id}: ${err instanceof Error ? err.message : String(err)}`
      );
      await moveToDeadLetter(ctx.notifDb, row, Number(row.attempts) + 1, nowMs);
      deadLettered++;
      return;
    }

    const hostKey = buildCircuitHostKey(row.channel, decryptedTarget, ctx.config);

    // If the host circuit breaker is currently open, reschedule WITHOUT incrementing attempts
    const existingBreaker = ctx.state.circuitBreakers.get(hostKey);
    if (existingBreaker && existingBreaker.openUntilMs > nowMs) {
      await ctx.notifDb.query(
        `UPDATE notif_deliveries
         SET status = 'retry', next_attempt_at = $2, claimed_at = NULL, lease_until = NULL, last_error = 'circuit breaker open'
         WHERE id = $1`,
        [row.id, existingBreaker.openUntilMs.toString()]
      );
      retried++;
      return;
    }

    const unsubToken = signUnsubscribeToken(
      ctx.config.unsubscribeSecret,
      row.subscription_id,
      row.wallet,
      30 * 86_400,
      nowMs
    );
    const unsubscribeUrl = `${ctx.config.publicBaseUrl}/unsubscribe?token=${encodeURIComponent(unsubToken)}`;

    let payloadObj: Record<string, unknown> = {};
    try {
      payloadObj = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      payloadObj = {};
    }

    const msg = {
      wallet: getAddress(row.wallet),
      subscriptionId: row.subscription_id,
      channel: row.channel,
      target: decryptedTarget,
      alertType: row.alert_type,
      severity: row.severity,
      title: row.title,
      message: row.message,
      payload: payloadObj,
      unsubscribeUrl,
      timestampSec: Math.floor(nowMs / 1000),
    };

    try {
      const sendTimeoutMs = ctx.config.outboundTimeoutMs + 250;
      await runWithSendTimeout(async () => {
        if (row.channel === 'email') await ctx.transports.sendEmail(msg);
        else if (row.channel === 'telegram') await ctx.transports.sendTelegram(msg);
        else await ctx.transports.sendWebhook(msg);
      }, sendTimeoutMs);

      ctx.state.circuitBreakers.set(hostKey, { consecutiveFailures: 0, openUntilMs: 0 });
      await ctx.notifDb.query(
        `UPDATE notif_deliveries
         SET status = 'sent', attempts = attempts + 1, sent_at = $2, claimed_at = NULL, lease_until = NULL, last_error = NULL
         WHERE id = $1`,
        [row.id, nowMs.toString()]
      );
      sent++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const prev = ctx.state.circuitBreakers.get(hostKey) ?? {
        consecutiveFailures: 0,
        openUntilMs: 0,
      };
      const consecutiveFailures = prev.consecutiveFailures + 1;
      const openUntilMs =
        consecutiveFailures >= ctx.config.circuitBreakerThreshold
          ? nowMs + ctx.config.circuitBreakerCooldownMs
          : 0;
      ctx.state.circuitBreakers.set(hostKey, { consecutiveFailures, openUntilMs });
      console.warn(
        `[NOTIF_DELIVERY_WARN] Delivery ${row.id} (${row.channel}/${hostKey}) failed: ${errMsg}`
      );

      const isCriticalRow =
        row.severity === 'critical' || CRITICAL_OVERRIDE_TYPES.has(row.alert_type as AlertType);
      const maxAttempts = isCriticalRow
        ? Math.max(ctx.config.maxCriticalDeliveryAttempts, ctx.config.maxDeliveryAttempts)
        : ctx.config.maxDeliveryAttempts;
      const nextAttempts = Number(row.attempts) + 1;
      if (nextAttempts >= maxAttempts) {
        await moveToDeadLetter(ctx.notifDb, row, nextAttempts, nowMs);
        deadLettered++;
      } else {
        const mult = BACKOFF_MULTIPLIERS[Math.min(nextAttempts - 1, BACKOFF_MULTIPLIERS.length - 1)];
        const delayMs = ctx.config.retryBaseMs * mult;
        const nextAt = nowMs + delayMs;
        await ctx.notifDb.query(
          `UPDATE notif_deliveries
           SET status = 'retry', attempts = $2, next_attempt_at = $3, claimed_at = NULL, lease_until = NULL, last_error = 'delivery failed'
           WHERE id = $1`,
          [row.id, nextAttempts, nextAt.toString()]
        );
        retried++;
      }
    }
  }

  const concurrency = Math.max(1, Math.min(ctx.config.deliveryConcurrency, claimed.length));
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIdx < claimed.length) {
        const current = claimed[nextIdx++];
        if (current) await processOne(current);
      }
    })
  );

  return { sent, retried, deadLettered };
}

export function defaultPreferencesMap(): Record<AlertType, boolean> {
  const out = {} as Record<AlertType, boolean>;
  for (const k of ALL_ALERT_TYPES) {
    out[k] = true;
  }
  return out;
}
