const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/ledger');

function fakeDb(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));
  const writes = [];
  let nextTransactionId = 0;
  const ref = (path) => ({ path, id: path.split('/').pop() });
  const snapshot = (path) => {
    const value = docs.get(path);
    return { exists: value !== undefined, data: () => value };
  };
  const db = {
    docs, writes,
    doc: ref,
    collection(name) {
      return {
        where(field, operator, value) {
          assert.equal(operator, '==');
          return {
            limit() {
              return {
                async get() {
                  const found = [...docs.entries()].find(([path, data]) =>
                    path.startsWith(`${name}/`) && data[field] === value);
                  return found
                    ? { empty: false, docs: [{ id: found[0].split('/').pop() }] }
                    : { empty: true, docs: [] };
                },
              };
            },
          };
        },
        doc() { return ref(`${name}/tx-${++nextTransactionId}`); },
      };
    },
    async runTransaction(callback) {
      const pending = [];
      const transaction = {
        async get(document) { return snapshot(document.path); },
        update(document, data) { pending.push({ kind: 'update', path: document.path, data }); },
        set(document, data) { pending.push({ kind: 'set', path: document.path, data }); },
      };
      const result = await callback(transaction);
      for (const write of pending) {
        writes.push(write);
        if (write.kind === 'set') docs.set(write.path, write.data);
      }
      return result;
    },
  };
  return db;
}

const accountDocs = {
  'accounts/sender': { accountNumber: 'CB0000000001', balance: 50000 },
  'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000 },
};

test('risk scoring flags a large transfer to a recent first-time recipient without blocking it', () => {
  const risk = ledger.assessTransferRisk({
    amount: 2500000,
    toUid: 'new-recipient',
    recent: [],
    now: 1000000,
  });

  assert.deepEqual(risk, {
    score: 50,
    level: 'MEDIUM',
    reasons: [
      'Large transfer (INR 25,000 or more)',
      'First transfer to this recipient in the recent activity window',
    ],
  });
});

test('risk scoring detects rapid transfers and large deviations from recent activity', () => {
  const now = 1000000;
  const risk = ledger.assessTransferRisk({
    amount: 3000000,
    toUid: 'new-recipient',
    recent: [
      { toUid: 'recipient-a', amount: 100000, createdAtMs: now - 60000 },
      { toUid: 'recipient-b', amount: 100000, createdAtMs: now - 120000 },
      { toUid: 'recipient-c', amount: 100000, createdAtMs: now - 180000 },
    ],
    now,
  });

  assert.equal(risk.level, 'HIGH');
  assert.equal(risk.score, 100);
  assert.equal(risk.reasons.length, 4);
});

test('ordinary repeat transfers remain low risk', () => {
  const now = 1000000;
  const risk = ledger.assessTransferRisk({
    amount: 1200,
    toUid: 'recipient',
    recent: [{ toUid: 'recipient', amount: 1200, createdAtMs: now - 3600000 }],
    now,
  });

  assert.deepEqual(risk, { score: 0, level: 'LOW', reasons: [] });
});

test('high-risk signals are saved with a completed transfer and its retry record', async () => {
  const db = fakeDb({
    'accounts/sender': { accountNumber: 'CB0000000001', balance: 6000000 },
    'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000 },
  });
  const result = await ledger.transfer(db, {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 5000000,
    idempotencyKey: 'large-transfer-001',
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.risk.level, 'HIGH');
  assert.equal(result.risk.score, 70);
  const recent = db.docs.get('riskSignals/sender').recent;
  assert.equal(recent.length, 1);
  assert.equal(recent[0].toUid, 'recipient');
  assert.equal(recent[0].amount, 5000000);
  const tx = [...db.docs.entries()].find(([path]) => path.startsWith('transactions/'))[1];
  assert.deepEqual(tx.risk, result.risk);
});

test('transfer retries return the original response and event without repeating ledger writes', async () => {
  const db = fakeDb(accountDocs);
  const request = {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 1200,
    idempotencyKey: 'retry-key-0001',
  };

  const first = await ledger.transfer(db, request);
  const writesAfterFirst = db.writes.length;
  const retry = await ledger.transfer(db, request);

  assert.equal(retry.duplicate, true);
  assert.equal(retry.txId, first.txId);
  assert.deepEqual(retry.event, first.event);
  assert.equal(db.writes.length, writesAfterFirst);
});

test('cash retries retain their event and are isolated from transfer keys', async () => {
  const db = fakeDb(accountDocs);
  const request = { uid: 'sender', amount: 500, type: 'DEPOSIT', idempotencyKey: 'shared-key-001' };

  const firstDeposit = await ledger.cash(db, request);
  const writeCount = db.writes.length;
  const retry = await ledger.cash(db, request);
  const transfer = await ledger.transfer(db, {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 500,
    idempotencyKey: request.idempotencyKey,
  });

  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.event, firstDeposit.event);
  assert.equal(db.writes.length, writeCount + 5);
  assert.equal(transfer.duplicate, undefined);
});

test('transfer retries continue to recognize existing legacy idempotency records', async () => {
  const legacyEvent = { txId: 'legacy-tx', type: 'TRANSFER' };
  const db = fakeDb({
    ...accountDocs,
    'idempotency/sender_legacy-key-001': {
      response: { txId: 'legacy-tx', status: 'COMPLETED', amount: 1200 },
      event: legacyEvent,
    },
  });

  const result = await ledger.transfer(db, {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 1200,
    idempotencyKey: 'legacy-key-001',
  });

  assert.equal(result.duplicate, true);
  assert.deepEqual(result.event, legacyEvent);
  assert.equal(db.writes.length, 0);
});
