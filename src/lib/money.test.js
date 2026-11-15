import assert from 'node:assert/strict';
import { termSheet, interestCents, dueInterestCents, liveInterestCents } from './money.js';
import { seedLoans, CLOCK } from './data.js';

const sheet = termSheet({ principalCents: 500000, rateBps: 800, termDays: 30 });
assert.equal(sheet.interest, 3288);
assert.equal(sheet.fee, 500);
assert.equal(sheet.proceeds, 499500);
assert.equal(sheet.repay, 503288);
assert.equal(sheet.cut, 329);
assert.equal(sheet.holderInterest, 2959);
assert.equal(sheet.holder, 502959);
assert.equal(sheet.borrowerApr, 923);
assert.equal(sheet.lenderApr, 720);

assert.equal(interestCents(500000, 800, 30 * 86400), 3288);

const grace = seedLoans().find((loan) => loan.id === '1846');
const termOnly = interestCents(300000, 750, 21 * 86400);
const withGrace = liveInterestCents(grace, CLOCK);
assert.ok(withGrace > termOnly);
assert.equal(dueInterestCents(grace, CLOCK, 300000), withGrace);

console.log('money ok');
