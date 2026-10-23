// Core ledger logic. ALL money is stored as integer paise (1 INR = 100 paise): no floating-point errors.
// Used by the Cloud Run API and by the scheduled (recurring payment) Cloud Function.
const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');
const MAX_AMOUNT = 10000000; // INR 1,00,000 per operation

const err = (status, message) => Object.assign(new Error(message), { status });
const checkAmount = (a) => {
  if (!Number.isInteger(a) || a <= 0) throw err(400, 'Amount must be greater than zero');
  if (a > MAX_AMOUNT) throw err(400, 'Amount exceeds the per-transaction limit of INR 1,00,000');
};

async function findAccountByNumber(db, number) {
  const s = await db.collection('accounts').where('accountNumber', '==', String(number)).limit(1).get();
  return s.empty ? null : s.docs[0];
}

const idempotencyRefs = (db, uid, operation, key) => ({
  current: db.doc(`idempotency/${crypto.createHash('sha256').update(JSON.stringify([uid, operation, key])).digest('hex')}`),
  legacy: db.doc(`idempotency/${uid}_${key}`),
});

// Atomic peer-to-peer transfer (FR-03) with idempotency protection (FR-04).
async function transfer(db, { fromUid, toAccountNumber, amount, note = '', idempotencyKey, source = 'API' }) {
  checkAmount(amount);
  const toDoc = await findAccountByNumber(db, toAccountNumber);
  if (!toDoc) throw err(404, 'Recipient account not found');
  const toUid = toDoc.id;
  if (toUid === fromUid) throw err(400, 'You cannot transfer to your own account');

  const fromRef = db.doc(`accounts/${fromUid}`);
  const toRef = db.doc(`accounts/${toUid}`);
  const idemRefs = idempotencyRefs(db, fromUid, 'transfer', idempotencyKey);

  return db.runTransaction(async (t) => {
    // all reads first
    const [idem, legacyIdem, from, to] = await Promise.all([
      t.get(idemRefs.current), t.get(idemRefs.legacy), t.get(fromRef), t.get(toRef),
    ]);
    const existingIdem = idem.exists ? idem : legacyIdem;
    if (existingIdem.exists) return { ...existingIdem.data().response, duplicate: true, event: existingIdem.data().event };   // retry -> same answer, no double charge
    if (!from.exists) throw err(404, 'Your account was not found');
    if (from.data().balance < amount) throw err(400, 'Insufficient funds');

    const txRef = db.collection('transactions').doc();
    const base = {
      txId: txRef.id, type: 'TRANSFER', fromUid, toUid,
      fromAccount: from.data().accountNumber, toAccount: to.data().accountNumber,
      amount, note: String(note).slice(0, 80), source,
    };
    t.update(fromRef, { balance: FieldValue.increment(-amount) });
    t.update(toRef, { balance: FieldValue.increment(amount) });
    t.set(txRef, { ...base, participants: [fromUid, toUid], status: 'COMPLETED', createdAt: FieldValue.serverTimestamp() });
    const response = { txId: txRef.id, status: 'COMPLETED', amount, toAccount: base.toAccount, newBalance: from.data().balance - amount };
    const event = { ...base, occurredAt: new Date().toISOString() };
    t.set(idemRefs.current, { response, event, createdAt: FieldValue.serverTimestamp() });
    return { ...response, event };
  });
}

// Simulated cash deposit / withdrawal
async function cash(db, { uid, amount, type, idempotencyKey }) {
  checkAmount(amount);
  const ref = db.doc(`accounts/${uid}`);
  const idemRefs = idempotencyRefs(db, uid, type.toLowerCase(), idempotencyKey);
  return db.runTransaction(async (t) => {
    const [idem, legacyIdem, acc] = await Promise.all([
      t.get(idemRefs.current), t.get(idemRefs.legacy), t.get(ref),
    ]);
    const existingIdem = idem.exists ? idem : legacyIdem;
    if (existingIdem.exists) return { ...existingIdem.data().response, duplicate: true, event: existingIdem.data().event };
    if (!acc.exists) throw err(404, 'Account not found');
    const delta = type === 'DEPOSIT' ? amount : -amount;
    if (acc.data().balance + delta < 0) throw err(400, 'Insufficient funds');
    const txRef = db.collection('transactions').doc();
    const base = {
      txId: txRef.id, type,
      fromUid: type === 'WITHDRAWAL' ? uid : null, toUid: type === 'DEPOSIT' ? uid : null,
      fromAccount: type === 'WITHDRAWAL' ? acc.data().accountNumber : 'CASH',
      toAccount: type === 'DEPOSIT' ? acc.data().accountNumber : 'CASH',
      amount, note: '', source: 'API',
    };
    t.update(ref, { balance: FieldValue.increment(delta) });
    t.set(txRef, { ...base, participants: [uid], status: 'COMPLETED', createdAt: FieldValue.serverTimestamp() });
    const response = { txId: txRef.id, status: 'COMPLETED', amount, newBalance: acc.data().balance + delta };
    const event = { ...base, occurredAt: new Date().toISOString() };
    t.set(idemRefs.current, { response, event, createdAt: FieldValue.serverTimestamp() });
    return { ...response, event };
  });
}

module.exports = { transfer, cash, findAccountByNumber, err, MAX_AMOUNT };
