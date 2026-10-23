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
  assert.equal(db.writes.length, writeCount + 4);
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
