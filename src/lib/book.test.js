import assert from 'node:assert/strict';
import { freshState, reducer } from './book.js';
import { health, phaseOf, releaseTokens } from './health.js';
import { formatApr, formatHundredths, formatUsd } from './format.js';
import { termSheet } from './money.js';

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

console.log('book ok');
