import assert from 'node:assert/strict';
import { freshState, reducer } from './book.js';
import { health, phaseOf, releaseTokens } from './health.js';
import { formatApr, formatHundredths, formatUsd } from './format.js';
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  getFrontendConfig,
  setFrontendConfigOverrides,
} from './contracts.js';
import {
  buildBookSummary,
  formatApiAmount,
  formatBpsPercent,
  parseDecimalToRaw,
  parsePercentToBps,
} from './marketsApi.js';
import { termSheet } from './money.js';
import { formatTokenUnitsDisplay, verifySiweChallengeParams } from './web3.js';

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
