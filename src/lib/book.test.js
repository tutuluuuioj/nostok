import assert from 'node:assert/strict';
import { freshState, reducer } from './book.js';
import { health, phaseOf, releaseTokens } from './health.js';
import { formatApr, formatHundredths, formatUsd } from './format.js';
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  buildContentSecurityPolicy,
  getFrontendConfig,
  setFrontendConfigOverrides,
} from './contracts.js';
import {
  buildBookSummary,
  buildDataMetricRows,
  buildProtocolFeeCards,
  buildRiskSummaryRows,
  formatApiAmount,
  formatBpsPercent,
  parseDecimalToRaw,
  parsePercentToBps,
} from './marketsApi.js';
import { termSheet } from './money.js';
import {
  DEFAULT_COLLATERAL_BUFFER_BPS,
  computeBorrowApprovalAmountRaw,
  decodeContractRevert,
  formatTokenUnitsDisplay,
  formatWeb3Error,
  loadPersistedSignedOrders,
  parseBorrowOrderFromJson,
  resolveExactBorrowAmounts,
  saveSignedBorrowOrder,
  verifySiweChallengeParams,
} from './web3.js';

const state = freshState();
const nvda = state.loans.find((loan) => loan.id === '1842');
const aapl = state.loans.find((loan) => loan.id === '1844');
const msft = state.loans.find((loan) => loan.id === '1846');
const meta = state.loans.find((loan) => loan.id === '1848');
const auction = state.loans.find((loan) => loan.id === '1854');

const nvdaHealth = health(nvda);
assert.equal(phaseOf(nvda), 'Active');
assert.equal(nvdaHealth.margin, false);
assert.ok(nvdaHealth.oracleValue > 0);
assert.ok(nvdaHealth.marketValue < nvdaHealth.oracleValue);

const aaplHealth = health(aapl);
assert.equal(aaplHealth.margin, true);
assert.equal(aaplHealth.atLiq, false);
assert.ok(aaplHealth.marketValue < aaplHealth.oracleValue);

assert.equal(phaseOf(msft), 'Grace');
assert.equal(health(meta).atLiq, true);
assert.equal(phaseOf(auction), 'Auction');

const frozen = reducer(state, { type: 'fill', id: 'b2202', usdcCents: 200000, inKind: false });
assert.match(frozen.error, /frozen/i);

const filled = reducer(state, { type: 'fill', id: 'b2201', usdcCents: 50000, inKind: false });
assert.equal(filled.error, '');
assert.equal(filled.lastLoanId, '4000');
assert.equal(filled.loans[0].lender, 'you');
assert.equal(filled.loans[0].principalCents, 50000);

const partial = releaseTokens(nvda, 100000);
assert.equal(partial.capped, true);
const after = reducer(state, { type: 'repay', id: '1842', principalCents: 100000 });
assert.equal(after.error, '');
const changed = after.loans.find((loan) => loan.id === '1842');
assert.ok(changed.tokenMicro < nvda.tokenMicro);
assert.ok(changed.tokenMicro > 0);

const topped = reducer(state, { type: 'topup', id: '1844', tokenMicro: 1000000 });
assert.equal(topped.error, '');
assert.ok(health(topped.loans.find((loan) => loan.id === '1844')).oracleValue > aaplHealth.oracleValue);

const locked = reducer(state, { type: 'list', id: '1854', priceCents: 500000 });
assert.match(locked.error, /locked/i);

const listed = reducer(state, { type: 'list', id: '1850', priceCents: 260000 });
assert.equal(listed.error, '');

const bought = reducer(state, { type: 'buy', id: 'lst1' });
assert.equal(bought.error, '');
assert.equal(bought.loans.find((loan) => loan.id === '1852').lender, 'you');

const claimed = reducer(state, { type: 'claim', id: 'cl1' });
assert.equal(claimed.error, '');
assert.equal(claimed.claims.find((item) => item.id === 'cl1').claimed, true);

const noSign = reducer(state, { type: 'extend', id: '1842', termDays: 30, rateBps: 800, capitalize: false, agreed: false });
assert.match(noSign.error, /sign/i);
const signed = reducer(state, { type: 'extend', id: '1842', termDays: 21, rateBps: 750, capitalize: false, agreed: true });
assert.equal(signed.error, '');

const rolled = reducer(state, { type: 'rollover', id: '1842', offerId: 'l3301' });
assert.equal(rolled.error, '');
assert.equal(rolled.loans.find((loan) => loan.id === '1842').status, 'Repaid');

const sheet = termSheet({ principalCents: 500000, rateBps: 800, termDays: 30 });
assert.equal(formatUsd(sheet.interest), '$32.88');
assert.equal(formatUsd(sheet.fee), '$5.00');
assert.equal(formatUsd(sheet.proceeds), '$4,995.00');
assert.equal(formatUsd(sheet.repay), '$5,032.88');
assert.equal(formatUsd(sheet.holder), '$5,029.59');
assert.equal(formatHundredths(sheet.borrowerApr), '9.23%');
assert.equal(formatHundredths(sheet.lenderApr), '7.20%');
assert.equal(formatApr(800), '8.00%');

// Low Fix #6 + WS3.2 helpers: exact decimals, <0.01 dust marker, config guards, SIWE domain/origin
assert.equal(formatTokenUnitsDisplay(0n, 6, 2), '0');
assert.equal(formatTokenUnitsDisplay(1n, 6, 2), '<0.01');
assert.equal(formatTokenUnitsDisplay(9_999n, 6, 2), '<0.01');
assert.equal(formatTokenUnitsDisplay(10_000n, 6, 2), '0.01');
assert.equal(formatTokenUnitsDisplay(1n, 18, 6), '<0.000001');
assert.equal(formatApiAmount({ raw: '1', decimals: 6, symbol: 'USDC' }, { prefixUsd: true }), '<$0.01');
assert.equal(formatApiAmount({ raw: '1250500000', decimals: 6, symbol: 'USDC' }, { prefixUsd: true }), '$1,250.50');
assert.equal(parseDecimalToRaw('10.25', 6), '10250000');
assert.equal(parseDecimalToRaw('10.1234567', 6), null);
assert.equal(parseDecimalToRaw('0', 6), null);
assert.equal(parsePercentToBps('8.25'), 825);
assert.equal(formatBpsPercent(6000), '60.00%');

const summary = buildBookSummary(
  [{ caps: { global_usdc_cap: { raw: '100000000000' }, global_remaining: { raw: '99500000000' } } }],
  [
    { order_type: 'borrow', cancelled: false, status: 'partially_filled' },
    { order_type: 'lend', cancelled: false, status: 'partially_filled' },
  ],
  [
    { status: 0, principal: { raw: '500000000' }, principal_repaid: { raw: '0' }, rate_bps: 800, bad_debt_shortfall: { raw: '0' } },
    { status: 3, principal: { raw: '600000000' }, principal_repaid: { raw: '600000000' }, rate_bps: 700, bad_debt_shortfall: { raw: '0' } },
  ],
  [{ status: 0 }]
);
assert.equal(summary.borrowOrders.length, 1);
assert.equal(summary.lendOffers.length, 1);
assert.equal(summary.activeLoansCount, 1);
assert.equal(summary.repaidLoansCount, 1);
assert.equal(summary.totalOutstandingUsdc.raw, '500000000');
assert.equal(summary.totalOriginatedUsdc.raw, '1100000000');
assert.equal(summary.weightedAverageAprBps, 800);
assert.equal(summary.activeAuctionsCount, 1);

const baseProdCfg = {
  isProd: true,
  isFork: false,
  chainId: BASE_CHAIN_ID,
  rpcUrl: 'https://base-mainnet.private-rpc.example/v1/key',
  apiUrl: 'https://api.nostok.xyz',
  notificationsUrl: 'https://notifications.nostok.xyz',
  riskUrl: 'https://risk.nostok.xyz',
  loanCore: '0x1111111111111111111111111111111111111111',
  orderSettlement: '0x2222222222222222222222222222222222222222',
  liquidationAuction: '0x3333333333333333333333333333333333333333',
  positionNft: '0x4444444444444444444444444444444444444444',
  collateralEscrow: '0x5555555555555555555555555555555555555555',
  assetRegistry: '0x6666666666666666666666666666666666666666',
  oracleRouter: '0x7777777777777777777777777777777777777777',
  eligibilityGate: '0x8888888888888888888888888888888888888888',
};
setFrontendConfigOverrides(baseProdCfg);
assert.equal(getFrontendConfig().usdcAddress, BASE_USDC_ADDRESS);

assert.throws(() => {
  setFrontendConfigOverrides({ ...baseProdCfg, chainId: 84532 });
  getFrontendConfig();
}, /VITE_CHAIN_ID=8453/);

assert.throws(() => {
  setFrontendConfigOverrides({ ...baseProdCfg, apiUrl: 'http://api.nostok.xyz' });
  getFrontendConfig();
}, /https:\/\//);

assert.throws(() => {
  setFrontendConfigOverrides({ ...baseProdCfg, rpcUrl: 'https://mainnet.base.org' });
  getFrontendConfig();
}, /private https:\/\//);

assert.throws(() => {
  setFrontendConfigOverrides({ ...baseProdCfg, eligibilityGate: '' });
  getFrontendConfig();
}, /eligibilityGate/);

assert.throws(() => {
  setFrontendConfigOverrides({ ...baseProdCfg, isFork: false, usdcAddress: '0x9999999999999999999999999999999999999999' });
  getFrontendConfig();
}, /prohibited outside fork/i);

// Fix #2: Production MUST ignore VITE_IS_FORK / FORK and keep BASE_USDC_ADDRESS pinned
const prevViteFork = process.env.VITE_IS_FORK;
const prevFork = process.env.FORK;
try {
  process.env.VITE_IS_FORK = 'true';
  process.env.FORK = 'true';
  setFrontendConfigOverrides({ ...baseProdCfg, isFork: true });
  const prodWithForkFlags = getFrontendConfig();
  assert.equal(prodWithForkFlags.isProd, true);
  assert.equal(prodWithForkFlags.isFork, false);
  assert.equal(prodWithForkFlags.usdcAddress, BASE_USDC_ADDRESS);

  assert.throws(() => {
    setFrontendConfigOverrides({
      ...baseProdCfg,
      isFork: true,
      usdcAddress: '0x9999999999999999999999999999999999999999',
    });
    getFrontendConfig();
  }, /prohibited outside fork/i);
} finally {
  if (prevViteFork === undefined) delete process.env.VITE_IS_FORK;
  else process.env.VITE_IS_FORK = prevViteFork;
  if (prevFork === undefined) delete process.env.FORK;
  else process.env.FORK = prevFork;
}

assert.throws(() => {
  setFrontendConfigOverrides({ ...baseProdCfg, riskUrl: 'http://risk.nostok.xyz' });
  getFrontendConfig();
}, /https:\/\//);

// Low CSP: exact origins instead of https: wildcard
const prodCspHeader = buildContentSecurityPolicy(baseProdCfg, { allowDevInlineScripts: true });
assert.ok(!/connect-src[^;]*\shttps:(?:\s|;|$)/.test(prodCspHeader), 'Prod CSP must not use https: wildcard');
assert.ok(!prodCspHeader.includes('127.0.0.1'), 'Prod CSP must not allow loopback');
assert.ok(!prodCspHeader.includes('unsafe-inline\'; font-src') && /script-src 'self';/.test(prodCspHeader), 'Prod script-src MUST ignore allowDevInlineScripts and stay strictly self');
assert.ok(prodCspHeader.includes('https://base-mainnet.private-rpc.example'));
assert.ok(prodCspHeader.includes('https://api.nostok.xyz'));
assert.ok(prodCspHeader.includes('https://notifications.nostok.xyz'));
assert.ok(prodCspHeader.includes('https://risk.nostok.xyz'));
assert.ok(prodCspHeader.includes("frame-ancestors 'none'"));
const prodCspMeta = buildContentSecurityPolicy(baseProdCfg, { includeFrameAncestors: false });
assert.ok(!prodCspMeta.includes('frame-ancestors'));
const devCspHeader = buildContentSecurityPolicy({ ...baseProdCfg, isProd: false }, { allowDevInlineScripts: true });
assert.ok(devCspHeader.includes("script-src 'self' 'unsafe-inline'"), 'Dev serve CSP must allow Vite React preamble inline script');
assert.ok(devCspHeader.includes('ws://127.0.0.1:*'), 'Dev CSP must allow Vite HMR websocket');

// Low Data.jsx: '+' suffix on every loan/order/auction count & sum when loansTruncated=true
const truncSummary = buildBookSummary(
  [{ caps: { global_usdc_cap: { raw: '1000000000', decimals: 6, symbol: 'USDC' }, global_remaining: { raw: '500000000', decimals: 6, symbol: 'USDC' } } }],
  [{ order_type: 'borrow', cancelled: false, status: 'open' }],
  [
    { status: 0, principal: { raw: '500000000' }, principal_repaid: { raw: '0' }, rate_bps: 800, bad_debt_shortfall: { raw: '0' } },
    { status: 3, principal: { raw: '600000000' }, principal_repaid: { raw: '600000000' }, rate_bps: 700, bad_debt_shortfall: { raw: '1000000' } },
  ],
  [{ status: 0 }],
  { loansTruncated: true }
);
const dataRows = buildDataMetricRows(
  truncSummary,
  { orders: [{ order_type: 'borrow', cancelled: false, status: 'open' }], fetchedAt: '2026-11-16T00:00:00Z' },
  { last_indexed_block: 10, chain_head_block: 10, lag_blocks: 0, freshness_timestamp: '2026-11-16T00:00:00Z' }
);
const rowMap = Object.fromEntries(dataRows.map((r) => [r.label, r.value]));
assert.match(rowMap['Outstanding principal'], /\+$/);
assert.match(rowMap['Total originated (indexed)'], /\+$/);
assert.match(rowMap['Active loans (status 0)'], /^\d+\+$/);
assert.match(rowMap['Loans in grace (status 1)'], /^\d+\+$/);
assert.match(rowMap['Loans in auction (status 2)'], /^\d+\+$/);
assert.equal(rowMap['Repaid / defaulted / liquidated'], '1+ / 0+ / 0+');
assert.match(rowMap['Active liquidation auctions'], /^\d+\+$/);
assert.match(rowMap['Indexed orders (active / total)'], /^\d+\+ \/ \d+\+$/);
assert.match(rowMap['Realized bad debt shortfall'], /\+$/);

// Fix #5 & Low Fees: risk summary exposes monitor_degraded, last_scan_error, last_scan_timestamp + fee cards from API
const riskRows = buildRiskSummaryRows({
  status: 'degraded',
  monitor_degraded: true,
  last_scan_error: 'Oracle RPC timeout',
  last_scan_timestamp: '2026-11-16T12:00:00.000Z',
  chain_head_block: 42000000,
  market_open: false,
  protocol_paused: false,
  global_usdc_cap: { raw: '1000000000', decimals: 6, symbol: 'USDC' },
  total_outstanding_principal: { raw: '500000000', decimals: 6, symbol: 'USDC' },
  loan_counts: { healthy: 1, margin_call: 0, near_liquidation: 0, liquidatable: 0, unknown: 2 },
});
const riskMap = Object.fromEntries(riskRows.map((r) => [r.label, r.value]));
assert.equal(riskMap['Monitor degraded (monitor_degraded)'], 'true (degraded)');
assert.equal(riskMap['Last scan error (last_scan_error)'], 'Oracle RPC timeout');
assert.equal(riskMap['Last scan timestamp (last_scan_timestamp)'], '2026-11-16T12:00:00.000Z');
assert.match(riskMap['Loans by risk (H / MC / NL / Liq / Unk)'], /\/ 2$/);

const feeCards = buildProtocolFeeCards({
  origination_fee_bps: 30,
  max_origination_bps: 200,
  interest_cut_bps: 1000,
  max_interest_cut_bps: 2000,
  liquidation_fee_bps: 500,
  max_liquidation_bps: 1000,
  safety_reserve_share_bps: 2500,
});
assert.equal(feeCards.length, 4);
assert.match(feeCards[0].detail, /0\.30% of principal\. Hard cap 2\.00%/);
assert.match(feeCards[3].detail, /25\.00% of collected protocol fees/);

// WS3.3 + M3: resolveExactBorrowAmounts defaults to +5.00% buffered raw collateral above minRequiredCollateralRaw
const quoteSample = {
  amounts: {
    principal: { raw: '700000000', formatted: '700', decimals: 6, symbol: 'USDC' },
    collateral_required: { raw: '8333333333333333334', formatted: '8.333333', decimals: 18, symbol: 'bNVDA' },
    origination_fee: { raw: '2100000', formatted: '2.1', decimals: 6, symbol: 'USDC' },
    net_proceeds: { raw: '697900000', formatted: '697.9', decimals: 6, symbol: 'USDC' },
    interest_maturity: { raw: '4602740', formatted: '4.60274', decimals: 6, symbol: 'USDC' },
    total_repayment_at_maturity: { raw: '704602740', formatted: '704.60274', decimals: 6, symbol: 'USDC' },
  },
};
const resolvedDefault = resolveExactBorrowAmounts(quoteSample);
assert.equal(resolvedDefault.principalRaw, 700000000n);
assert.equal(resolvedDefault.minRequiredCollateralRaw, 8333333333333333334n);
assert.equal(resolvedDefault.bufferBps, DEFAULT_COLLATERAL_BUFFER_BPS);
assert.equal(resolvedDefault.bufferedCollateralRaw, 8750000000000000001n);
assert.equal(resolvedDefault.collateralAmountRaw, 8750000000000000001n);
assert.equal(resolvedDefault.maxFills, 1n);
assert.equal(resolvedDefault.approvalSlackRaw, 1n);
assert.equal(resolvedDefault.requiredApprovalRaw, 8750000000000000002n);
assert.equal(
  resolveExactBorrowAmounts(quoteSample, { bufferBps: 0 }).collateralAmountRaw,
  8333333333333333334n
);
const resolvedMulti = resolveExactBorrowAmounts(
  {
    amounts: {
      ...quoteSample.amounts,
      principal: { raw: '2000000000', formatted: '2000', decimals: 6, symbol: 'USDC' },
    },
  },
  { minFillRaw: '600000000' }
);
assert.equal(resolvedMulti.maxFills, 4n);
assert.equal(resolvedMulti.approvalSlackRaw, 4n);
assert.equal(resolvedMulti.requiredApprovalRaw, resolvedMulti.collateralAmountRaw + 4n);
assert.equal(computeBorrowApprovalAmountRaw('1000', '1500000000', '500000000').approvalSlackRaw, 3n);
assert.equal(computeBorrowApprovalAmountRaw('1000', '1000000000', '500000000').approvalSlackRaw, 2n);
assert.equal(computeBorrowApprovalAmountRaw('1000', '2000000000', '1000000').approvalSlackRaw, 4n);
assert.throws(
  () => resolveExactBorrowAmounts(quoteSample, { userCollateralRaw: '8333333000000000000' }),
  /below API rounded-up minimum/i
);
assert.equal(
  resolveExactBorrowAmounts(quoteSample, { userCollateralRaw: '9000000000000000000' }).collateralAmountRaw,
  9000000000000000000n
);

// M4 + Low: custom error decoding & M5 persisted storage + paste-JSON parse
assert.equal(decodeContractRevert({ data: '0x8c0fe5c3' })?.errorName, 'LtvExceeded');
assert.match(formatWeb3Error({ cause: { data: '0x8c0fe5c3' } }), /LtvExceeded/);

const memStoreMap = new Map();
const memStorage = {
  getItem: (k) => memStoreMap.get(k) ?? null,
  setItem: (k, v) => memStoreMap.set(k, v),
};
const sampleOrder = {
  borrower: '0x1111111111111111111111111111111111111111',
  collateralToken: '0x2222222222222222222222222222222222222222',
  collateralAmount: '8750000000000000001',
  minUsdc: '700000000',
  maxRateBps: 800,
  termDays: 30,
  maxLtvBps: 6000,
  minFill: '500000000',
  expiry: '1900000000',
  nonce: '0',
  yieldMode: 0,
  allowInKindSettlement: false,
};
saveSignedBorrowOrder({ orderHash: '0x' + 'ab'.repeat(32), orderJson: sampleOrder, signature: '0x' + 'cd'.repeat(65) }, memStorage);
assert.equal(loadPersistedSignedOrders(memStorage).length, 1);
const parsedOrder = parseBorrowOrderFromJson(JSON.stringify({ order: sampleOrder, signature: '0x' + 'cd'.repeat(65) }));
assert.equal(parsedOrder.order.collateralAmount, 8750000000000000001n);

setFrontendConfigOverrides({});

assert.throws(
  () =>
    verifySiweChallengeParams(
      { domain: 'evil.example', uri: 'https://app.nostok.xyz', chain_id: 8453 },
      { chainId: 8453 },
      { location: { host: 'app.nostok.xyz', origin: 'https://app.nostok.xyz' } }
    ),
  /SIWE domain mismatch/
);
assert.throws(
  () =>
    verifySiweChallengeParams(
      { domain: 'app.nostok.xyz', uri: 'https://evil.example/login', chain_id: 8453 },
      { chainId: 8453 },
      { location: { host: 'app.nostok.xyz', origin: 'https://app.nostok.xyz' } }
    ),
  /SIWE URI origin mismatch/
);
assert.throws(
  () =>
    verifySiweChallengeParams(
      { domain: 'app.nostok.xyz', uri: 'https://app.nostok.xyz', chain_id: 1 },
      { chainId: 8453 },
      { location: { host: 'app.nostok.xyz', origin: 'https://app.nostok.xyz' } }
    ),
  /SIWE challenge chain_id mismatch/
);

console.log('book ok');
