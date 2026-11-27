// node src/tests/providerBalance.test.js — Runware balance alert steps, spend rate, alert text.
import assert from 'node:assert/strict';
import { stepFor, spendRate, alertText, isBalanceError } from '../../utils/providerBalance.js';

// Steps: $100, $50, $20, $10, $5, then empty.
assert.equal(stepFor(250), null);
assert.equal(stepFor(100), 100);
assert.equal(stepFor(73), 100);
assert.equal(stepFor(49.9), 50);
assert.equal(stepFor(18), 20);
assert.equal(stepFor(5.64), 10);
assert.equal(stepFor(4.2), 5);
assert.equal(stepFor(0), 0);
assert.equal(stepFor(-1), 0);

// Spend rate ignores top-ups and scales to a day.
const t0 = Date.parse('2026-11-27T00:00:00Z');
const at = (h) => new Date(t0 + h * 3_600_000).toISOString();
const r = spendRate([{ at: at(0), b: 40 }, { at: at(6), b: 34 }, { at: at(7), b: 134 }, { at: at(12), b: 128 }], 128, t0 + 12 * 3_600_000);
assert.equal(Math.round(r.spent24h), 24);           // $12 over 12 h
assert.equal(Math.round(r.daysLeft * 10), 53);       // 128 / 24
assert.deepEqual(spendRate([{ at: at(0), b: 10 }], 10, t0), { spent24h: null, daysLeft: null });

// Provider wording that means "balance too low".
assert.ok(isBalanceError('Insufficient credits, this request requires a minimum balance of 6 credits.'));
assert.ok(!isBalanceError('Invalid content detected.'));

// Alert text: failure counts split subscribers / free users, video minimum warning, top-up link.
const failures = { attempts: 5, subscriberAttempts: 4, subscribers: 1, freeAttempts: 1, freeUsers: 1, otherRequests: 0 };
const low = alertText({ balance: 5.64, step: 10, rate: { spent24h: 3, daysLeft: 1.9 }, failures });
assert.match(low, /\$5\.64: under \$10\.00/);
assert.match(low, /Full video clips stop below \$6\.00/);
assert.match(low, /subscribers: 4 attempts by 1 user/);
assert.match(low, /free users: 1 attempt by 1 user/);
assert.match(low, /my\.runware\.ai\/wallet/);
assert.match(alertText({ balance: 0.4, step: 0, failures }), /EMPTY/);
assert.match(alertText({ balance: 120, step: null, toppedUp: true }), /topped up.*\$120\.00/);
assert.doesNotMatch(alertText({ balance: 90, step: 100 }), /Failed because/); // counts only from $20 down
console.log('providerBalance: all groups passed');
console.log('\n--- sample alert ---\n' + low);
