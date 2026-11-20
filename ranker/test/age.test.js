import test from 'node:test';
import assert from 'node:assert/strict';
import { ageUnits, cadenceFor, cadenceMapFromSources } from '../age.js';

test('ageUnits: floors in feed cycles, daily by default, never negative', () => {
  assert.equal(ageUnits(5, 1), 5);
  assert.equal(ageUnits(5.9, 1), 5);
  assert.equal(ageUnits(59, 30), 1);
  assert.equal(ageUnits(60, 30), 2);
  assert.equal(ageUnits(89, 30), 2);
  assert.equal(ageUnits(0, 30), 0);
  assert.equal(ageUnits(-3, 30), 0);
  // A zero/absent/garbage cadence must not divide by zero: it means daily.
  assert.equal(ageUnits(10, 0), 10);
  assert.equal(ageUnits(10, undefined), 10);
  assert.equal(ageUnits(10, 'x'), 10);
  assert.equal(ageUnits(10, 2.9), 5); // cadence is floored too
});

test('cadenceMapFromSources: reads feeds.api and feeds.rss, defaults to 1', () => {
  const src = {
    feeds: {
      api: {
        journals: [{ name: 'J', cadence_days: 30 }, { name: 'D' }],
        broken: 'not-an-array',
      },
      rss: [{ name: 'R', cadence_days: 60 }, { name: 'S' }, { url: 'no-name' }],
    },
  };
  const m = cadenceMapFromSources(src);
  assert.equal(m.get('J'), 30);
  assert.equal(m.get('D'), 1);
  assert.equal(m.get('R'), 60);
  assert.equal(m.get('S'), 1);
  assert.equal(m.size, 4);
  assert.equal(cadenceFor(m, 'missing'), 1);
  assert.equal(cadenceFor(null, 'J'), 1);
});

test('cadenceMapFromSources: tolerates a missing feeds block', () => {
  assert.equal(cadenceMapFromSources(undefined).size, 0);
  assert.equal(cadenceMapFromSources({}).size, 0);
});
