const test = require('node:test');
const assert = require('node:assert/strict');
const { nextOccurrence } = require('../../shared/recurrence');

test('daily and weekly schedules preserve the scheduled time', () => {
  const scheduledAt = new Date('2026-10-26T03:30:00.000Z');

  assert.equal(nextOccurrence(scheduledAt, { frequency: 'DAILY' }).toISOString(), '2026-10-27T03:30:00.000Z');
  assert.equal(nextOccurrence(scheduledAt, { frequency: 'WEEKLY' }).toISOString(), '2026-11-02T03:30:00.000Z');
});

test('monthly schedule clamps short months and restores the anchored day', () => {
  const order = { frequency: 'MONTHLY', scheduleDayOfMonth: 31 };
  const february = nextOccurrence(new Date('2026-01-31T03:30:00.000Z'), order);
  const march = nextOccurrence(february, order);

  assert.equal(february.toISOString(), '2026-02-28T03:30:00.000Z');
  assert.equal(march.toISOString(), '2026-03-31T03:30:00.000Z');
});

test('legacy interval schedules remain supported', () => {
  const next = nextOccurrence(new Date('2026-10-26T03:30:00.000Z'), { intervalDays: 30 });

  assert.equal(next.toISOString(), '2026-11-25T03:30:00.000Z');
});
