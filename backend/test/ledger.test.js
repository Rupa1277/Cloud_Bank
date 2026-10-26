const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/ledger');

function fakeDb(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));
  const writes = [];
  let nextTransactionId = 0;
  const snapshot = (path) => {
    const value = docs.get(path);
    return { exists: value !== undefined, id: path.split('/').pop(), data: () => value };
  };
  const ref = (path) => ({ path, id: path.split('/').pop(), get: async () => snapshot(path) });
  const db = {
    docs, writes,
    doc: ref,
    collection(name) {
      return {
        where(field, operator, value) {
          assert.equal(operator, '==');
          return {
            limit() {
              const query = {
                async get() {
                  const found = [...docs.entries()].find(([path, data]) =>
                    path.startsWith(`${name}/`) && data[field] === value);
                  return found
                    ? { empty: false, docs: [{
                      id: found[0].split('/').pop(),
                      ref: ref(found[0]),
                      data: () => found[1],
                    }] }
                    : { empty: true, docs: [] };
                },
              };
              return query;
            },
          };
        },
        doc() { return ref(`${name}/tx-${++nextTransactionId}`); },
      };
    },
    async runTransaction(callback) {
      const pending = [];
      const transaction = {
        async get(document) {
          return document.path ? snapshot(document.path) : document.get();
        },
        update(document, data) { pending.push({ kind: 'update', path: document.path, data }); },
        set(document, data) { pending.push({ kind: 'set', path: document.path, data }); },
        delete(document) { pending.push({ kind: 'delete', path: document.path }); },
      };
      const result = await callback(transaction);
      for (const write of pending) {
        writes.push(write);
        if (write.kind === 'set') docs.set(write.path, write.data);
        if (write.kind === 'update' && write.path.startsWith('riskConfirmations/')) {
          docs.set(write.path, { ...docs.get(write.path), ...write.data });
        }
        if (write.kind === 'delete') docs.delete(write.path);
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

async function allowWhenRequired(db, request, result) {
  if (!result.confirmationRequired) return result;
  return ledger.transfer(db, {
    ...request,
    riskDecision: 'ALLOW',
    riskConfirmationId: result.confirmationId,
  });
}

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

test('velocity signal triggers on the third transfer inside two minutes', () => {
  const now = 1000000;
  const risk = ledger.assessTransferRisk({
    amount: 10000,
    toUid: 'recipient',
    recent: [
      { toUid: 'recipient', amount: 10000, createdAtMs: now - 60000 },
      { toUid: 'recipient', amount: 10000, createdAtMs: now - 90000 },
    ],
    now,
  });

  assert.equal(risk.score, 35);
  assert.equal(risk.level, 'MEDIUM');
  assert.deepEqual(risk.reasons, ['Multiple transfers within a short time']);
});

test('velocity signal ignores transfers older than the two-minute window', () => {
  const now = 1000000;
  const risk = ledger.assessTransferRisk({
    amount: 10000,
    toUid: 'recipient',
    recent: [
      { toUid: 'recipient', amount: 10000, createdAtMs: now - 121000 },
      { toUid: 'recipient', amount: 10000, createdAtMs: now - 180000 },
    ],
    now,
  });

  assert.deepEqual(risk, { score: 0, level: 'LOW', reasons: [] });
});

test('three serial transfers produce a velocity signal on the third transfer', async () => {
  const db = fakeDb(accountDocs);
  const results = [];
  for (let index = 1; index <= 3; index += 1) {
    const request = {
      fromUid: 'sender',
      toAccountNumber: 'CB0000000002',
      amount: 10000,
      idempotencyKey: `demo-velocity-${index}`,
      source: 'FRAUD_DEMO',
    };
    const result = await ledger.transfer(db, request);
    results.push(await allowWhenRequired(db, request, result));
  }

  assert.equal(results[0].risk.level, 'LOW');
  assert.equal(results[1].risk.level, 'LOW');
  assert.equal(results[2].risk.score, 35);
  assert.equal(results[2].risk.level, 'MEDIUM');
  assert.deepEqual(results[2].risk.reasons, ['Multiple transfers within a short time']);
  assert.equal(db.docs.get('riskSignals/sender').recent.length, 3);
});

test('new account remains pending without KYC and opens once with a 1,000 INR balance', async () => {
  const db = fakeDb();
  const pending = await ledger.initializeAccount(db, {
    uid: 'new-user', email: 'new@example.com', profile: {},
  });

  assert.equal(pending.account.accountStatus, 'PENDING_VERIFICATION');
  assert.equal(pending.account.balance, 0);
  assert.ok(pending.kycErrors.includes('phone'));

  const profile = {
    fullName: 'Demo Customer',
    phone: '9876543210',
    pan: 'ABCDE1234F',
    addressProofType: 'AADHAAR',
    addressProofNumber: '123412341234',
    photoUrl: 'this field is no longer used',
  };
  const active = await ledger.initializeAccount(db, {
    uid: 'new-user', email: 'new@example.com', profile, kycSecret: 'x'.repeat(64),
  });
  const repeated = await ledger.initializeAccount(db, {
    uid: 'new-user', email: 'new@example.com', profile, kycSecret: 'x'.repeat(64),
  });
  const stored = db.docs.get('accounts/new-user');

  assert.equal(active.account.accountStatus, 'ACTIVE');
  assert.equal(active.account.balance, 100000);
  assert.equal(repeated.account.balance, 100000);
  assert.equal(stored.phone, undefined);
  assert.equal(stored.pan, undefined);
  assert.equal(stored.addressProofNumber, undefined);
  assert.equal(stored.passportPhotoUrl, undefined);
  assert.equal(stored.phoneMasked, '******3210');
  assert.equal(stored.panMasked, 'AB******4F');
  assert.ok(db.docs.has(`phone_to_account/${stored.phoneLookupHash}`));
  assert.ok(db.docs.has(`kycIdentifiers/${stored.panHash}`));
  assert.ok(db.docs.has(`kycIdentifiers/${stored.addressProofHash}`));
});

test('phone recipient lookup and transfer use the hashed phone index', async () => {
  const secret = 'y'.repeat(64);
  const phoneHash = require('node:crypto').createHmac('sha256', secret).update('phone:9876543210').digest('hex');
  const db = fakeDb({
    'accounts/sender': { accountNumber: 'CB0000000001', balance: 50000, accountStatus: 'ACTIVE' },
    'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000, accountStatus: 'ACTIVE' },
    [`phone_to_account/${phoneHash}`]: { uid: 'recipient' },
  });
  const result = await ledger.transfer(db, {
    fromUid: 'sender', toPhone: '9876543210', kycSecret: secret, amount: 1200,
    idempotencyKey: 'phone-transfer-001',
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.toAccount, 'CB0000000002');
});

test('aborted insufficient-funds transfer writes a failed audit record without ledger writes', async () => {
  const db = fakeDb({
    'accounts/sender': { accountNumber: 'CB0000000001', balance: 1000, accountStatus: 'ACTIVE' },
    'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000, accountStatus: 'ACTIVE' },
    'accountNumbers/CB0000000002': { uid: 'recipient' },
  });
  let failureEvent;
  await assert.rejects(ledger.transfer(db, {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 2000,
    idempotencyKey: 'insufficient-funds-001',
    onFailure: async (event) => { failureEvent = event; },
  }), { status: 400, message: 'Insufficient funds' });

  const attempt = [...db.docs.entries()].find(([path]) => path.startsWith('transferAttempts/'))[1];
  assert.equal(attempt.status, 'FAILED');
  assert.equal(attempt.type, 'TRANSFER_FAILED');
  assert.equal(failureEvent.txId, attempt.txId);
  assert.equal(db.docs.has('transactions/tx-1'), false);
  assert.equal(db.writes.some((write) => write.path.startsWith('accounts/')), false);
});

test('medium-risk transfer pauses before balance writes and only commits after explicit approval', async () => {
  const db = fakeDb({
    'accounts/sender': { accountNumber: 'CB0000000001', balance: 3000000, accountStatus: 'ACTIVE' },
    'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000, accountStatus: 'ACTIVE' },
    'accountNumbers/CB0000000002': { uid: 'recipient' },
  });
  const request = {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 2500000,
    idempotencyKey: 'risk-approval-001',
  };

  const preview = await ledger.transfer(db, request);
  assert.equal(preview.status, 'CONFIRMATION_REQUIRED');
  assert.equal(preview.risk.level, 'MEDIUM');
  assert.equal(db.docs.get('accounts/sender').balance, 3000000);
  assert.equal(db.docs.has('transactions/tx-1'), false);

  const approved = await ledger.transfer(db, {
    ...request, riskDecision: 'ALLOW', riskConfirmationId: preview.confirmationId,
  });
  assert.equal(approved.status, 'COMPLETED');
  assert.equal(approved.risk.score, 50);
  assert.equal(db.docs.get('accounts/sender').balance, 3000000);
  assert.ok(db.writes.some((write) => write.kind === 'update' && write.path === 'accounts/sender'));
  assert.ok(db.writes.some((write) => write.kind === 'update' &&
    write.path === `riskConfirmations/${preview.confirmationId}` && write.data.status === 'COMPLETED'));
});

test('sender can block a risk-confirmation request without moving funds and the decline is auditable', async () => {
  const db = fakeDb({
    'accounts/sender': { accountNumber: 'CB0000000001', balance: 3000000, accountStatus: 'ACTIVE' },
    'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000, accountStatus: 'ACTIVE' },
    'accountNumbers/CB0000000002': { uid: 'recipient' },
  });
  const request = {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 2500000,
    idempotencyKey: 'risk-block-0001',
  };
  const preview = await ledger.transfer(db, request);
  const blocked = await ledger.transfer(db, {
    ...request, riskDecision: 'BLOCK', riskConfirmationId: preview.confirmationId,
  });
  const audit = db.docs.get(`transferAttempts/${preview.confirmationId}`);

  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.event.type, 'TRANSFER_BLOCKED');
  assert.equal(audit.status, 'BLOCKED');
  assert.equal(db.docs.get('accounts/sender').balance, 3000000);
  assert.equal(db.docs.get('accounts/recipient').balance, 1000);
  assert.ok(db.writes.some((write) => write.kind === 'update' &&
    write.path === `riskConfirmations/${preview.confirmationId}` && write.data.status === 'BLOCKED'));
  assert.equal(db.writes.some((write) => write.path.startsWith('accounts/')), false);
  assert.equal(db.docs.has('transactions/tx-1'), false);
});

test('risk changes while awaiting approval require a fresh decision', async () => {
  const db = fakeDb({
    'accounts/sender': { accountNumber: 'CB0000000001', balance: 4000000, accountStatus: 'ACTIVE' },
    'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000, accountStatus: 'ACTIVE' },
    'accountNumbers/CB0000000002': { uid: 'recipient' },
  });
  const pendingRequest = {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 2500000,
    idempotencyKey: 'risk-refresh-001',
  };
  const preview = await ledger.transfer(db, pendingRequest);
  await ledger.transfer(db, {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 1000,
    idempotencyKey: 'risk-refresh-other',
  });

  const refreshed = await ledger.transfer(db, {
    ...pendingRequest, riskDecision: 'ALLOW', riskConfirmationId: preview.confirmationId,
  });
  assert.equal(refreshed.confirmationRequired, true);
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.risk.score, 40);
  assert.equal(db.docs.get('accounts/sender').balance, 4000000);

  const approved = await ledger.transfer(db, {
    ...pendingRequest, riskDecision: 'ALLOW', riskConfirmationId: preview.confirmationId,
  });
  assert.equal(approved.status, 'COMPLETED');
  assert.equal(db.docs.get('accounts/sender').balance, 4000000);
  assert.equal(db.writes.filter((write) => write.kind === 'update' && write.path === 'accounts/sender').length, 2);
});

test('fraud demo scoring produces high-value, first-recipient, and third-transfer velocity signals', async () => {
  const db = fakeDb({
    'accounts/sender': { accountNumber: 'CB0000000001', balance: 15000000 },
    'accounts/recipient': { accountNumber: 'CB0000000002', balance: 1000 },
  });
  const results = [];
  for (let index = 1; index <= 3; index += 1) {
    const request = {
      fromUid: 'sender',
      toAccountNumber: 'CB0000000002',
      amount: 5000000,
      idempotencyKey: `demo-high-value-${index}`,
      source: 'FRAUD_DEMO',
    };
    const result = await ledger.transfer(db, request);
    results.push(await allowWhenRequired(db, request, result));
  }

  assert.deepEqual(results.map(({ status, risk }) => [status, risk.score, risk.level]), [
    ['COMPLETED', 70, 'HIGH'],
    ['COMPLETED', 60, 'HIGH'],
    ['COMPLETED', 95, 'HIGH'],
  ]);
  assert.deepEqual(results.map(({ risk }) => risk.reasons), [
    [
      'High-value transfer (INR 50,000 or more)',
      'First transfer to this recipient in the recent activity window',
    ],
    ['High-value transfer (INR 50,000 or more)'],
    [
      'High-value transfer (INR 50,000 or more)',
      'Multiple transfers within a short time',
    ],
  ]);
  for (const result of results) {
    const transaction = db.docs.get(`transactions/${result.txId}`);
    assert.equal(transaction.risk_score, result.risk.score);
    assert.equal(transaction.risk_level, result.risk.level);
    assert.deepEqual(transaction.risk_reasons, result.risk.reasons);
  }
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
  const confirmed = await allowWhenRequired(db, {
    fromUid: 'sender', toAccountNumber: 'CB0000000002', amount: 5000000,
    idempotencyKey: 'large-transfer-001',
  }, result);

  assert.equal(confirmed.status, 'COMPLETED');
  assert.equal(confirmed.risk.level, 'HIGH');
  assert.equal(confirmed.risk.score, 70);
  const recent = db.docs.get('riskSignals/sender').recent;
  assert.equal(recent.length, 1);
  assert.equal(recent[0].toUid, 'recipient');
  assert.equal(recent[0].amount, 5000000);
  const tx = [...db.docs.entries()].find(([path]) => path.startsWith('transactions/'))[1];
  assert.deepEqual(tx.risk, confirmed.risk);
  assert.equal(tx.risk_score, confirmed.risk.score);
  assert.equal(tx.risk_level, confirmed.risk.level);
  assert.deepEqual(tx.risk_reasons, confirmed.risk.reasons);
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
