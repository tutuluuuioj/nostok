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
  type NotificationChannel,
  createDefaultTransports,
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

export interface NotificationsContext {
  config: NotificationsConfig;
  publicClient: PublicClient<Transport, Chain>;
  indexerDb: ReadOnlyIndexerDatabase;
  notifDb: NotifDatabase;
  cipher: PiiCipher;
  transports: ChannelTransports;
  state: {
    cycleCount: number;
    lastSyncTimestamp: string | null;
    lastError: string | null;
    lastRiskFetchOk: boolean;
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
  'asset_frozen_or_corporate_action',
]);

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
  const transports =
    opts.transportsOverride ??
    createDefaultTransports({
      smtpApiUrl: config.smtpApiUrl,
      smtpApiKey: config.smtpApiKey,
      emailFrom: config.emailFrom,
      telegramBotToken: config.telegramBotToken,
      telegramApiBase: config.telegramApiBase,
      outboundTimeoutMs: config.outboundTimeoutMs,
    });

  return {
    config,
    publicClient,
    indexerDb,
    notifDb,
    cipher,
    transports,
    state: {
      cycleCount: 0,
      lastSyncTimestamp: null,
      lastError: null,
      lastRiskFetchOk: false,
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

export async function runNotificationsCycle(
  ctx: NotificationsContext,
  nowMs = Date.now()
): Promise<SyncCycleStats> {
  ctx.state.cycleCount += 1;
  ctx.state.lastSyncTimestamp = new Date(nowMs).toISOString();

  // 1. Identify subscribed wallets and preferences
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
       WHERE enabled = TRUE`
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
    // 2. Read open loans, lender owners, assets, and new events strictly via SELECT-only queries
    const [openLoansRes, eventsRes, assetsRes, riskState, latestBlock] = await Promise.all([
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

    // Build set of open loans by wallet (for maturity countdowns, risk states, oracle/asset alerts)
    const openLoansByAsset = new Map<string, Array<{ loan_id: string; borrower: string; lender: string | null }>>();
    for (const loan of openLoansRes.rows) {
      const tok = loan.collateral_token.toLowerCase();
      const holder = (loan.nft_owner ?? loan.lender)?.toLowerCase() ?? null;
      const arr = openLoansByAsset.get(tok) ?? [];
      arr.push({ loan_id: loan.loan_id, borrower: loan.borrower.toLowerCase(), lender: holder });
      openLoansByAsset.set(tok, arr);
    }

    // 3. Process chronological events from indexer (liquidation started, auction bid, settled, repaid, claimable)
    for (const ev of eventsRes.rows) {
      const eid = BigInt(ev.id);
      if (eid > maxProcessedEventId) maxProcessedEventId = eid;

      const borrower = ev.borrower?.toLowerCase() ?? null;
      const lenderHolder = (ev.nft_owner ?? ev.lender)?.toLowerCase() ?? null;
      const recipients = new Set<string>();
      if (borrower && subsByWallet.has(borrower)) recipients.add(borrower);
      if (lenderHolder && subsByWallet.has(lenderHolder)) recipients.add(lenderHolder);

      if (ev.event_name === 'AuctionStarted') {
        for (const wallet of recipients) {
          candidates.push({
            wallet,
            alertType: 'liquidation_started',
            severity: 'critical',
            criticalOverride: true,
            dedupKey: `liquidation_started:${ev.loan_id ?? ev.id}`,
            title: `Liquidation started on Loan #${ev.loan_id ?? '?'}`,
            message: `Loan #${ev.loan_id ?? '?'} entered liquidation auction at block ${ev.block_number}.`,
            payload: { loan_id: ev.loan_id, event_id: ev.id, block_number: ev.block_number },
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
            title: `Auction bid filled on Loan #${ev.loan_id ?? '?'}`,
            message: `Auction fill executed (${ev.secondary_amount ?? '0'} USDC raw) for Loan #${ev.loan_id ?? '?'}.`,
            payload: {
              loan_id: ev.loan_id,
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
            dedupKey: `auction_settled:${ev.loan_id ?? ev.id}`,
            title: `Auction settled on Loan #${ev.loan_id ?? '?'}`,
            message: `Auction settled for Loan #${ev.loan_id ?? '?'} (total USDC ${ev.amount_raw ?? '0'} raw).`,
            payload: { loan_id: ev.loan_id, event_id: ev.id, total_usdc_raw: ev.amount_raw },
          });
        }
        if (lenderHolder && subsByWallet.has(lenderHolder)) {
          candidates.push({
            wallet: lenderHolder,
            alertType: 'lender_claimable',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `lender_claimable:settled:${ev.loan_id ?? ev.id}`,
            title: `Claimable funds available for Loan #${ev.loan_id ?? '?'}`,
            message: `Settlement proceeds from Loan #${ev.loan_id ?? '?'} can now be claimed via LoanCore.claim().`,
            payload: { loan_id: ev.loan_id, event_id: ev.id },
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
                ? `Loan #${ev.loan_id ?? '?'} repaid in full`
                : `Partial repayment on Loan #${ev.loan_id ?? '?'}`,
            message: `Repayment recorded on Loan #${ev.loan_id ?? '?'} (principal=${ev.amount_raw ?? '0'} raw).`,
            payload: { loan_id: ev.loan_id, event_name: ev.event_name, principal_paid_raw: ev.amount_raw },
          });
        }
        if (lenderHolder && subsByWallet.has(lenderHolder)) {
          candidates.push({
            wallet: lenderHolder,
            alertType: 'lender_claimable',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `lender_claimable:repay:${ev.id}`,
            title: `Lender claimable funds from Loan #${ev.loan_id ?? '?'}`,
            message: `Repayment on Loan #${ev.loan_id ?? '?'} added claimable USDC to your lender balance.`,
            payload: { loan_id: ev.loan_id, event_id: ev.id },
          });
        }
      }
    }

    // 4. Risk state: consume Risk Monitor HTTP state if available, otherwise compute directly on-chain
    const riskLoans = riskState?.loans ?? [];
    if (riskState) {
      for (const rl of riskLoans) {
        const borrower = rl.borrower.toLowerCase();
        if (!subsByWallet.has(borrower)) continue;
        if (rl.risk_status === 'margin_call') {
          candidates.push({
            wallet: borrower,
            alertType: 'loan_margin_call',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: `margin_call:${rl.loan_id}`,
            title: `Margin call on Loan #${rl.loan_id}`,
            message: `Loan #${rl.loan_id} LTV reached ${rl.current_ltv_bps} bps. Add collateral or repay to lower risk.`,
            payload: { loan_id: rl.loan_id, current_ltv_bps: rl.current_ltv_bps },
          });
        } else if (rl.risk_status === 'near_liquidation' || rl.risk_status === 'liquidatable') {
          candidates.push({
            wallet: borrower,
            alertType: 'loan_near_liquidation',
            severity: 'warning',
            criticalOverride: false,
            dedupKey: `near_liq:${rl.loan_id}`,
            title: `Loan #${rl.loan_id} near liquidation`,
            message: `Loan #${rl.loan_id} LTV is ${rl.current_ltv_bps} bps (status=${rl.risk_status}). Immediate action advised.`,
            payload: {
              loan_id: rl.loan_id,
              current_ltv_bps: rl.current_ltv_bps,
              risk_status: rl.risk_status,
            },
          });
        }
      }

      for (const ra of riskState.alerts) {
        const tok = typeof ra.details?.token === 'string' ? ra.details.token.toLowerCase() : null;
        if (!tok) continue;
        const sym = symbolByToken.get(tok) ?? tok;
        const affected = openLoansByAsset.get(tok) ?? [];

        if (
          ra.category === 'corporate_action' ||
          (ra.category === 'asset_status' && ra.dedup_key.endsWith(':frozen'))
        ) {
          for (const entry of affected) {
            for (const w of [entry.borrower, entry.lender]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'asset_frozen_or_corporate_action',
                severity: 'critical',
                criticalOverride: true,
                dedupKey: `asset_frozen:${tok}:${entry.loan_id}:${ra.dedup_key}`,
                title: `${sym} corporate action / frozen notice (Loan #${entry.loan_id})`,
                message: ra.message,
                payload: { loan_id: entry.loan_id, token: tok, alert_key: ra.dedup_key },
              });
            }
          }
        } else if (ra.category === 'oracle' && ra.dedup_key.startsWith('oracle_stale:')) {
          for (const entry of affected) {
            for (const w of [entry.borrower, entry.lender]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'oracle_stale',
                severity: 'warning',
                criticalOverride: false,
                dedupKey: `oracle_stale:${tok}:${entry.loan_id}`,
                title: `Oracle stale notice for ${sym} (Loan #${entry.loan_id})`,
                message: ra.message,
                payload: { loan_id: entry.loan_id, token: tok },
              });
            }
          }
        }
      }
    } else {
      // On-chain read-only fallback when RISK_API_URL is omitted/down
      const assetDecMap = new Map(
        assetsRes.rows.map((a) => [a.token.toLowerCase(), a.decimals !== null ? Number(a.decimals) : 18])
      );
      for (const l of openLoansRes.rows) {
        if (l.status >= 2) continue;
        const tok = l.collateral_token.toLowerCase();
        const borrower = l.borrower.toLowerCase();
        const holder = (l.nft_owner ?? l.lender)?.toLowerCase() ?? null;
        try {
          const [onchainLoan, dueInt, priceRes, cfgRes] = await Promise.all([
            ctx.publicClient.readContract({
              address: ctx.config.loanCore,
              abi: loanCoreAbi,
              functionName: 'getLoan',
              args: [BigInt(l.loan_id)],
            }),
            ctx.publicClient.readContract({
              address: ctx.config.loanCore,
              abi: loanCoreAbi,
              functionName: 'getDueInterest',
              args: [BigInt(l.loan_id)],
            }),
            ctx.publicClient.readContract({
              address: ctx.config.oracleRouter,
              abi: oracleRouterAbi,
              functionName: 'getPrice',
              args: [getAddress(l.collateral_token)],
            }),
            ctx.publicClient.readContract({
              address: ctx.config.assetRegistry,
              abi: assetRegistryAbi,
              functionName: 'getAssetConfig',
              args: [getAddress(l.collateral_token)],
            }),
          ]);

          const sym = symbolByToken.get(tok) ?? l.collateral_token;
          const oPrice = priceRes[0];
          const oDec = Number(priceRes[1]);
          const oState = Number(priceRes[2]);
          const aStatus = Number(cfgRes.status);

          if (oState === OracleState.FROZEN_CORPORATE_ACTION || aStatus === 3) {
            for (const w of [borrower, holder]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'asset_frozen_or_corporate_action',
                severity: 'critical',
                criticalOverride: true,
                dedupKey: `asset_frozen:${tok}:${l.loan_id}:${oState}:${aStatus}`,
                title: `${sym} corporate action / frozen notice (Loan #${l.loan_id})`,
                message: `${sym} collateral has oracle state ${oState} / AssetStatus ${aStatus}.`,
                payload: { loan_id: l.loan_id, token: tok, oracle_state: oState, asset_status: aStatus },
              });
            }
          }
          if (oState === OracleState.STALE_FEED) {
            for (const w of [borrower, holder]) {
              if (!w || !subsByWallet.has(w)) continue;
              candidates.push({
                wallet: w,
                alertType: 'oracle_stale',
                severity: 'warning',
                criticalOverride: false,
                dedupKey: `oracle_stale:${tok}:${l.loan_id}`,
                title: `Oracle stale notice for ${sym} (Loan #${l.loan_id})`,
                message: `Oracle price feed for ${sym} is STALE_FEED.`,
                payload: { loan_id: l.loan_id, token: tok },
              });
            }
          }

          if (subsByWallet.has(borrower) && onchainLoan.status < 2) {
            const dec = assetDecMap.get(tok) ?? 18;
            const scale = 10n ** BigInt(dec) * 10n ** BigInt(oDec);
            const grossUsdc =
              onchainLoan.collateralRaw > 0n && oPrice > 0n
                ? (onchainLoan.collateralRaw * oPrice * 1_000_000n) / scale
                : 0n;
            const principalRem =
              onchainLoan.principal > onchainLoan.principalRepaid
                ? onchainLoan.principal - onchainLoan.principalRepaid
                : 0n;
            const totalDebt = principalRem + dueInt;
            const ltvBps = grossUsdc > 0n ? Number((totalDebt * 10_000n) / grossUsdc) : 100_000;
            const nearThresh = Math.max(onchainLoan.marginCallLtvBps, onchainLoan.liqLtvBps - 300);

            if (ltvBps >= nearThresh) {
              candidates.push({
                wallet: borrower,
                alertType: 'loan_near_liquidation',
                severity: 'warning',
                criticalOverride: false,
                dedupKey: `near_liq:${l.loan_id}`,
                title: `Loan #${l.loan_id} near liquidation`,
                message: `Loan #${l.loan_id} LTV is ${ltvBps} bps (liq threshold=${onchainLoan.liqLtvBps} bps).`,
                payload: { loan_id: l.loan_id, current_ltv_bps: ltvBps },
              });
            } else if (ltvBps >= onchainLoan.marginCallLtvBps) {
              candidates.push({
                wallet: borrower,
                alertType: 'loan_margin_call',
                severity: 'warning',
                criticalOverride: false,
                dedupKey: `margin_call:${l.loan_id}`,
                title: `Margin call on Loan #${l.loan_id}`,
                message: `Loan #${l.loan_id} LTV reached ${ltvBps} bps.`,
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

    // 5. Maturity reminders (3d / 1d / 6h before maturity) using block.timestamp
    const blockTs = latestBlock.timestamp;
    for (const loan of openLoansRes.rows) {
      if (loan.status !== 0) continue;
      const borrower = loan.borrower.toLowerCase();
      if (!subsByWallet.has(borrower)) continue;
      const maturity = BigInt(loan.maturity);
      if (blockTs >= maturity) continue;
      const secsLeft = Number(maturity - blockTs);
      if (secsLeft <= 21_600) {
        candidates.push({
          wallet: borrower,
          alertType: 'maturity_reminder_6h',
          severity: 'critical',
          criticalOverride: true,
          dedupKey: `maturity_6h:${loan.loan_id}:${loan.maturity}`,
          title: `Urgent: Loan #${loan.loan_id} matures in < 6 hours`,
          message: `Loan #${loan.loan_id} reaches maturity in ${Math.max(1, Math.floor(secsLeft / 60))} minutes.`,
          payload: { loan_id: loan.loan_id, seconds_remaining: secsLeft, maturity: loan.maturity },
        });
      } else if (secsLeft <= 86_400) {
        candidates.push({
          wallet: borrower,
          alertType: 'maturity_reminder_1d',
          severity: 'warning',
          criticalOverride: false,
          dedupKey: `maturity_1d:${loan.loan_id}:${loan.maturity}`,
          title: `Reminder: Loan #${loan.loan_id} matures in < 24 hours`,
          message: `Loan #${loan.loan_id} matures in ${Math.max(1, Math.floor(secsLeft / 3600))} hours.`,
          payload: { loan_id: loan.loan_id, seconds_remaining: secsLeft, maturity: loan.maturity },
        });
      } else if (secsLeft <= 259_200) {
        candidates.push({
          wallet: borrower,
          alertType: 'maturity_reminder_3d',
          severity: 'warning',
          criticalOverride: false,
          dedupKey: `maturity_3d:${loan.loan_id}:${loan.maturity}`,
          title: `Reminder: Loan #${loan.loan_id} matures within 3 days`,
          message: `Loan #${loan.loan_id} matures in ${Math.max(1, Math.floor(secsLeft / 3600))} hours.`,
          payload: { loan_id: loan.loan_id, seconds_remaining: secsLeft, maturity: loan.maturity },
        });
      }
    }

    // 6. Direct on-chain getClaimable balance check for subscribed wallets
    for (const wallet of subscribedWallets) {
      try {
        const amt = await ctx.publicClient.readContract({
          address: ctx.config.loanCore,
          abi: loanCoreAbi,
          functionName: 'getClaimable',
          args: [getAddress(wallet)],
        });
        if (amt > 0n) {
          candidates.push({
            wallet,
            alertType: 'lender_claimable',
            severity: 'info',
            criticalOverride: false,
            dedupKey: `lender_claimable:bal:${amt.toString()}`,
            title: 'USDC funds ready to claim',
            message: `You have ${amt.toString()} USDC (6 decimals) claimable in LoanCore.`,
            payload: { claimable_raw: amt.toString() },
          });
        }
      } catch {
        // non-fatal check
      }
    }
  }

  // 7. Filter by preferences, dedup, quiet hours (critical override), per-user hourly rate limit & enqueue
  let enqueued = 0;
  let suppressedQuiet = 0;
  let suppressedRateLimit = 0;
  const nowUtcHour = new Date(nowMs).getUTCHours();

  // Track in-batch per-wallet hourly counts to avoid burst bypass within a single scan
  const batchSentCountByWallet = new Map<string, number>();

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

    let walletSentLastHour = batchSentCountByWallet.get(cand.wallet);
    if (walletSentLastHour === undefined) {
      const rlRes = await ctx.notifDb.query<{ cnt: number }>(
        `SELECT COUNT(*)::INT AS cnt
         FROM notif_deliveries
         WHERE wallet = $1 AND status IN ('sent', 'pending', 'retry') AND created_at >= $2`,
        [cand.wallet, (nowMs - 3_600_000).toString()]
      );
      walletSentLastHour = Number(rlRes.rows[0]?.cnt ?? 0);
    }

    const isCritical = CRITICAL_OVERRIDE_TYPES.has(cand.alertType) || cand.criticalOverride;

    for (const sub of subs) {
      let initialStatus: string = 'pending';
      if (quietActive && !isCritical) {
        initialStatus = 'suppressed_quiet_hours';
      } else if (walletSentLastHour >= maxPerHour) {
        initialStatus = 'suppressed_rate_limit';
      }

      const id = `dlv_${crypto.randomUUID().replace(/-/g, '')}`;
      const ins = await ctx.notifDb.query<{ id: string }>(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $12)
         ON CONFLICT (subscription_id, dedup_key) DO NOTHING
         RETURNING id`,
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
        if (initialStatus === 'suppressed_quiet_hours') {
          suppressedQuiet++;
        } else if (initialStatus === 'suppressed_rate_limit') {
          suppressedRateLimit++;
        } else {
          enqueued++;
          walletSentLastHour++;
          batchSentCountByWallet.set(cand.wallet, walletSentLastHour);
        }
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

  // 8. Dispatch due pending & retry deliveries (backoff + dead-letter queue)
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

export async function processDeliveryQueue(
  ctx: NotificationsContext,
  nowMs = Date.now()
): Promise<{ sent: number; retried: number; deadLettered: number }> {
  const dueRes = await ctx.notifDb.query<{
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
  }>(
    `SELECT
       d.id, d.wallet, d.subscription_id, d.channel, d.alert_type, d.severity, d.dedup_key,
       d.title, d.message, d.payload_json, d.attempts,
       s.target_ciphertext, s.key_id, s.enabled AS sub_enabled
     FROM notif_deliveries d
     JOIN notif_subscriptions s ON s.id = d.subscription_id
     WHERE d.status IN ('pending', 'retry') AND d.next_attempt_at <= $1
     ORDER BY d.created_at ASC
     LIMIT 100`,
    [nowMs.toString()]
  );

  let sent = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const row of dueRes.rows) {
    if (!row.sub_enabled) {
      await ctx.notifDb.query(
        "UPDATE notif_deliveries SET status = 'unsubscribed' WHERE id = $1",
        [row.id]
      );
      continue;
    }

    const decryptedTarget = ctx.cipher.decrypt(row.target_ciphertext, row.key_id);
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
    };

    try {
      if (row.channel === 'email') await ctx.transports.sendEmail(msg);
      else if (row.channel === 'telegram') await ctx.transports.sendTelegram(msg);
      else await ctx.transports.sendWebhook(msg);

      await ctx.notifDb.query(
        `UPDATE notif_deliveries
         SET status = 'sent', attempts = attempts + 1, sent_at = $2, last_error = NULL
         WHERE id = $1`,
        [row.id, nowMs.toString()]
      );
      sent++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const nextAttempts = Number(row.attempts) + 1;
      if (nextAttempts >= ctx.config.maxDeliveryAttempts) {
        const dlqId = `dlq_${crypto.randomUUID().replace(/-/g, '')}`;
        await ctx.notifDb.transaction(async (tx) => {
          await tx.query(
            `UPDATE notif_deliveries
             SET status = 'dead_letter', attempts = $2, last_error = $3
             WHERE id = $1`,
            [row.id, nextAttempts, errMsg]
          );
          await tx.query(
            `INSERT INTO notif_dead_letters (
               id, delivery_id, wallet, subscription_id, channel, alert_type, dedup_key,
               payload_json, attempts, last_error, failed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              dlqId,
              row.id,
              row.wallet,
              row.subscription_id,
              row.channel,
              row.alert_type,
              row.dedup_key,
              row.payload_json,
              nextAttempts,
              errMsg,
              nowMs.toString(),
            ]
          );
        });
        deadLettered++;
      } else {
        const delayMs = ctx.config.retryBaseMs * 2 ** (nextAttempts - 1);
        const nextAt = nowMs + delayMs;
        await ctx.notifDb.query(
          `UPDATE notif_deliveries
           SET status = 'retry', attempts = $2, next_attempt_at = $3, last_error = $4
           WHERE id = $1`,
          [row.id, nextAttempts, nextAt.toString(), errMsg]
        );
        retried++;
      }
    }
  }

  return { sent, retried, deadLettered };
}

export function defaultPreferencesMap(): Record<AlertType, boolean> {
  const out = {} as Record<AlertType, boolean>;
  for (const k of ALL_ALERT_TYPES) {
    out[k] = true;
  }
  return out;
}
