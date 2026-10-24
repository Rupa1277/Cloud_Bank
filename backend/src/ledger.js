// Core ledger logic. ALL money is stored as integer paise (1 INR = 100 paise): no floating-point errors.
// Used by the Cloud Run API and by the scheduled (recurring payment) Cloud Function.
const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');
const MAX_AMOUNT = 10000000; // INR 1,00,000 per operation
const RISK_HISTORY_LIMIT = 20;
const RISK_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RAPID_TRANSFER_WINDOW_MS = 5 * 60 * 1000;

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

function assessTransferRisk({ amount, toUid, recent = [], now = Date.now() }) {
  const history = (Array.isArray(recent) ? recent : []).filter((item) =>
    Number.isInteger(item.amount) && typeof item.toUid === 'string' &&
    Number.isFinite(item.createdAtMs) && item.createdAtMs >= now - RISK_HISTORY_WINDOW_MS);
  const reasons = [];
  let score = 0;

  if (amount >= 5000000) {
    score += 60;
    reasons.push('High-value transfer (INR 50,000 or more)');
  } else if (amount >= 2500000) {
    score += 40;
    reasons.push('Large transfer (INR 25,000 or more)');
  }

  if (history.length >= 3) {
    const average = history.reduce((total, item) => total + item.amount, 0) / history.length;
    if (amount >= 500000 && amount >= average * 3) {
      score += 35;
      reasons.push('Amount is at least 3x your recent transfer average');
    }
  }

  const rapidCount = history.filter((item) => item.createdAtMs >= now - RAPID_TRANSFER_WINDOW_MS).length;
  if (rapidCount >= 2) {
    score += 35;
    reasons.push('Multiple transfers within a short time');
  }

  if (!history.some((item) => item.toUid === toUid)) {
    score += 10;
    reasons.push('First transfer to this recipient in the recent activity window');
  }

  const cappedScore = Math.min(score, 100);
  return {
    score: cappedScore,
    level: cappedScore >= 60 ? 'HIGH' : cappedScore >= 30 ? 'MEDIUM' : 'LOW',
    reasons,
  };
}

// Atomic peer-to-peer transfer (FR-03) with idempotency protection (FR-04).
async function transfer(db, { fromUid, toAccountNumber, amount, note = '', idempotencyKey, source = 'API' }) {
  checkAmount(amount);
  const toDoc = await findAccountByNumber(db, toAccountNumber);
  if (!toDoc) throw err(404, 'Recipient account not found');
  const toUid = toDoc.id;
  if (toUid === fromUid) throw err(400, 'You cannot transfer to your own account');

  const fromRef = db.doc(`accounts/${fromUid}`);
  const toRef = db.doc(`accounts/${toUid}`);
  const riskStateRef = db.doc(`riskSignals/${fromUid}`);
  const idemRefs = idempotencyRefs(db, fromUid, 'transfer', idempotencyKey);

  return db.runTransaction(async (t) => {
    // all reads first
    const [idem, legacyIdem, from, to, riskState] = await Promise.all([
      t.get(idemRefs.current), t.get(idemRefs.legacy), t.get(fromRef), t.get(toRef), t.get(riskStateRef),
    ]);
    const existingIdem = idem.exists ? idem : legacyIdem;
    if (existingIdem.exists) return { ...existingIdem.data().response, duplicate: true, event: existingIdem.data().event };   // retry -> same answer, no double charge
    if (!from.exists) throw err(404, 'Your account was not found');
    if (from.data().balance < amount) throw err(400, 'Insufficient funds');

    const now = Date.now();
    const recent = riskState.exists && Array.isArray(riskState.data().recent) ? riskState.data().recent : [];
    const risk = assessTransferRisk({ amount, toUid, recent, now });
    const recentTransfers = recent
      .filter((item) => Number.isFinite(item.createdAtMs) && item.createdAtMs >= now - RISK_HISTORY_WINDOW_MS)
      .concat({ toUid, amount, createdAtMs: now })
      .slice(-RISK_HISTORY_LIMIT);
    const txRef = db.collection('transactions').doc();
    const base = {
      txId: txRef.id, type: 'TRANSFER', fromUid, toUid,
      fromAccount: from.data().accountNumber, toAccount: to.data().accountNumber,
      amount, note: String(note).slice(0, 80), source, risk,
    };
    t.update(fromRef, { balance: FieldValue.increment(-amount) });
    t.update(toRef, { balance: FieldValue.increment(amount) });
    t.set(txRef, { ...base, participants: [fromUid, toUid], status: 'COMPLETED', createdAt: FieldValue.serverTimestamp() });
    const response = { txId: txRef.id, status: 'COMPLETED', amount, toAccount: base.toAccount, newBalance: from.data().balance - amount, risk };
    const event = { ...base, occurredAt: new Date().toISOString() };
    t.set(idemRefs.current, { response, event, createdAt: FieldValue.serverTimestamp() });
    t.set(riskStateRef, { recent: recentTransfers, updatedAt: FieldValue.serverTimestamp() });
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

module.exports = { transfer, cash, findAccountByNumber, assessTransferRisk, err, MAX_AMOUNT };
