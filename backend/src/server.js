// Cloud Bank API (Cloud Run). Stateless: all state lives in Firestore, so it can scale 0 -> N.
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const admin = require('firebase-admin');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { PubSub } = require('@google-cloud/pubsub');
const { Storage } = require('@google-cloud/storage');
const ledger = require('./ledger');

admin.initializeApp();                       // uses the Cloud Run service account (no keys in code)
const db = admin.firestore();
const pubsub = new PubSub();
const storage = new Storage();
const BUCKET = process.env.STATEMENT_BUCKET;
const TOPIC_TX = process.env.TOPIC_TX || 'transaction-completed';
const TOPIC_STMT = process.env.TOPIC_STMT || 'statement-requests';
const WELCOME_BONUS = 1000000;               // simulated INR 10,000 starting balance (paise)

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Internal server error' });
});

// FR-01: verify the Firebase JWT on every request.  FR-02: role comes from custom claims.
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    const d = await admin.auth().verifyIdToken(h.slice(7));
    req.user = { uid: d.uid, email: d.email, role: d.role || 'customer' };
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
const requireRole = (role) => (req, res, next) =>
  req.user.role === role ? next() : res.status(403).json({ error: 'Forbidden' });

const toPaise = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw ledger.err(400, 'Enter a valid amount');
  return Math.round(n * 100);
};
const nextSchedulerRunAt = () => {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(3, 30, 0, 0); // 09:00 Asia/Kolkata, matching the Cloud Scheduler job.
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Timestamp.fromDate(next);
};
const idemKey = (req) => {
  const k = req.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(k)) throw ledger.err(400, 'Idempotency-Key header (8-100 chars) is required');
  return k;
};
// FR-05: publish AFTER the database commit; a publish failure must not fail the user's transfer.
async function publish(topic, payload) {
  try { await pubsub.topic(topic).publishMessage({ json: payload }); }
  catch (e) { console.error('publish failed', topic, e.message); }
}
const strip = ({ event, ...rest }) => rest;

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ---- Account ----
app.post('/api/account/init', auth, wrap(async (req, res) => {
  const ref = db.doc(`accounts/${req.user.uid}`);
  if (!(await ref.get()).exists) {
    let number;
    do { number = 'CB' + String(crypto.randomInt(0, 1e10)).padStart(10, '0'); }
    while (await ledger.findAccountByNumber(db, number));
    try {
      await ref.create({
        ownerName: String(req.body.name || '').trim().slice(0, 60) || (req.user.email || 'user').split('@')[0],
        email: req.user.email, accountNumber: number, balance: WELCOME_BONUS, createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if (e.code !== 6 && e.code !== 'already-exists') throw e;
    }
  }
  const u = await admin.auth().getUser(req.user.uid);
  if (!u.customClaims || !u.customClaims.role) {
    await admin.auth().setCustomUserClaims(req.user.uid, { ...u.customClaims, role: 'customer' });
  }
  res.json({ ok: true });
}));

app.get('/api/account', auth, wrap(async (req, res) => {
  const s = await db.doc(`accounts/${req.user.uid}`).get();
  if (!s.exists) return res.status(404).json({ error: 'Account not initialised' });
  const { ownerName, email, accountNumber, balance } = s.data();
  res.json({ ownerName, email, accountNumber, balance, role: req.user.role });
}));

// ---- Money movement ----
app.post('/api/transfer', auth, wrap(async (req, res) => {
  const r = await ledger.transfer(db, {
    fromUid: req.user.uid, toAccountNumber: String(req.body.toAccount || '').trim().toUpperCase(),
    amount: toPaise(req.body.amount), note: req.body.note || '', idempotencyKey: idemKey(req),
  });
  if (r.event) await publish(TOPIC_TX, r.event);          // async fan-out: notify + audit
  res.status(200).json(strip(r));
}));
app.post('/api/demo/simulate-fraud', auth, requireRole('admin'), wrap(async (req, res) => {
  if (process.env.DEMO_FRAUD_SIMULATION_ENABLED !== 'true') {
    throw ledger.err(404, 'Fraud simulation is disabled');
  }

  const accountNumber = String(req.body?.recipientAccount || '').trim().toUpperCase();
  if (!accountNumber) throw ledger.err(400, 'recipientAccount is required');
  const key = idemKey(req);
  // The default INR 50,000 amount activates the high-value signal; a smaller amount can isolate velocity scoring.
  const amount = toPaise(req.body?.amount ?? 50000);
  if (amount > ledger.MAX_AMOUNT) throw ledger.err(400, 'Amount exceeds the per-transaction limit of INR 1,00,000');

  const recipient = await ledger.findAccountByNumber(db, accountNumber);
  if (!recipient) throw ledger.err(404, 'Recipient account not found');
  if (recipient.id === req.user.uid) throw ledger.err(400, 'Recipient must be another account');

  const runKey = crypto.createHash('sha256').update(`${req.user.uid}:${key}`).digest('hex').slice(0, 40);
  const replayRefs = Array.from({ length: 3 }, (_, index) =>
    ledger.idempotencyRefs(db, req.user.uid, 'transfer', `fraud_demo_${runKey}_${index + 1}`).current);
  const replaySnapshots = await Promise.all(replayRefs.map((ref) => ref.get()));
  const transfersRemaining = replaySnapshots.filter((snapshot) => !snapshot.exists).length;
  const sender = await db.doc(`accounts/${req.user.uid}`).get();
  if (!sender.exists) throw ledger.err(404, 'Your account was not found');
  if (sender.data().balance < amount * transfersRemaining) {
    throw ledger.err(400, `The demo needs enough simulated balance for ${transfersRemaining} remaining transfer(s)`);
  }

  const results = [];
  const events = [];
  for (let index = 1; index <= 3; index += 1) {
    // Reusing one recipient and sending serially makes transfer three see two prior transfers inside two minutes.
    const result = await ledger.transfer(db, {
      fromUid: req.user.uid,
      toAccountNumber: accountNumber,
      amount,
      note: `Fraud demo ${index}/3`,
      idempotencyKey: `fraud_demo_${runKey}_${index}`,
      source: 'FRAUD_DEMO',
    });
    if (result.event) events.push(result.event);
    results.push({
      txId: result.txId, status: result.status, amount: result.amount,
      duplicate: Boolean(result.duplicate), risk: result.risk,
    });
  }

  await Promise.all(events.map((event) => publish(TOPIC_TX, event)));
  res.status(200).json({
    simulation: 'completed',
    transfers: results,
    note: 'Simulated transfers are not blocked. This rule-based risk signal is for demonstration only.',
  });
}));
for (const [path, type] of [['deposit', 'DEPOSIT'], ['withdraw', 'WITHDRAWAL']]) {
  app.post(`/api/${path}`, auth, wrap(async (req, res) => {
    const r = await ledger.cash(db, { uid: req.user.uid, amount: toPaise(req.body.amount), type, idempotencyKey: idemKey(req) });
    if (r.event) await publish(TOPIC_TX, r.event);
    res.json(strip(r));
  }));
}

app.get('/api/transactions', auth, wrap(async (req, res) => {
  const s = await db.collection('transactions').where('participants', 'array-contains', req.user.uid)
    .orderBy('createdAt', 'desc').limit(50).get();
  res.json(s.docs.map((d) => {
    const t = d.data();
    return { txId: d.id, type: t.type, amount: t.amount, note: t.note, status: t.status,
      direction: t.fromUid === req.user.uid ? 'DEBIT' : 'CREDIT',
      counterparty: t.fromUid === req.user.uid ? t.toAccount : t.fromAccount,
      risk: t.fromUid === req.user.uid ? t.risk || null : null,
      createdAt: t.createdAt.toDate() };
  }));
}));

app.get('/api/notifications', auth, wrap(async (req, res) => {
  const s = await db.collection(`users/${req.user.uid}/notifications`).orderBy('createdAt', 'desc').limit(15).get();
  res.json(s.docs.map((d) => ({ id: d.id, message: d.data().message, createdAt: d.data().createdAt.toDate() })));
}));

// ---- Statements (FR-08): generated asynchronously, delivered by signed URL ----
app.post('/api/statements', auth, wrap(async (req, res) => {
  const month = String(req.body.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw ledger.err(400, 'month must look like 2026-10');
  const ref = db.collection(`users/${req.user.uid}/statements`).doc();
  await ref.set({ month, status: 'PENDING', createdAt: FieldValue.serverTimestamp() });
  await publish(TOPIC_STMT, { uid: req.user.uid, statementId: ref.id, month });
  res.status(202).json({ statementId: ref.id, status: 'PENDING' });
}));
app.get('/api/statements', auth, wrap(async (req, res) => {
  const s = await db.collection(`users/${req.user.uid}/statements`).orderBy('createdAt', 'desc').limit(12).get();
  res.json(s.docs.map((d) => ({ id: d.id, month: d.data().month, status: d.data().status })));
}));
app.get('/api/statements/:id/download', auth, wrap(async (req, res) => {
  const s = await db.doc(`users/${req.user.uid}/statements/${req.params.id}`).get();   // path includes caller's uid: no access to others' files
  if (!s.exists) throw ledger.err(404, 'Statement not found');
  if (s.data().status !== 'READY') throw ledger.err(409, 'Statement is not ready yet');
  const [url] = await storage.bucket(BUCKET).file(s.data().path).getSignedUrl({
    version: 'v4', action: 'read', expires: Date.now() + 10 * 60 * 1000,                 // valid 10 minutes
  });
  res.json({ url, expiresInSeconds: 600 });
}));

// ---- Recurring payments (executed by Cloud Scheduler -> Pub/Sub -> scheduled function) ----
app.post('/api/standing-orders', auth, wrap(async (req, res) => {
  const toAccount = String(req.body.toAccount || '').trim().toUpperCase();
  const frequency = String(req.body.frequency || '').toUpperCase();
  const intervalDays = Number(req.body.intervalDays);
  const supportedFrequencies = ['DAILY', 'WEEKLY', 'MONTHLY'];
  const legacyInterval = !frequency && [1, 7, 30].includes(intervalDays);
  if (!supportedFrequencies.includes(frequency) && !legacyInterval) {
    throw ledger.err(400, 'frequency must be DAILY, WEEKLY or MONTHLY');
  }
  const amount = toPaise(req.body.amount);
  if (amount > ledger.MAX_AMOUNT) throw ledger.err(400, 'Amount exceeds the per-transaction limit of INR 1,00,000');
  const to = await ledger.findAccountByNumber(db, toAccount);
  if (!to || to.id === req.user.uid) throw ledger.err(400, 'Invalid recipient account');
  const firstRunAt = nextSchedulerRunAt();
  const ref = await db.collection('standingOrders').add({
    ownerUid: req.user.uid, toAccount, amount,
    ...(legacyInterval ? { intervalDays } : { frequency, scheduleDayOfMonth: firstRunAt.toDate().getUTCDate() }),
    active: true,
    nextRunAt: firstRunAt, createdAt: FieldValue.serverTimestamp(),
  });
  res.status(201).json({ id: ref.id });
}));
app.get('/api/standing-orders', auth, wrap(async (req, res) => {
  const s = await db.collection('standingOrders').where('ownerUid', '==', req.user.uid).get();
  res.json(s.docs.map((d) => { const o = d.data();
    const frequency = o.frequency || ({ 1: 'DAILY', 7: 'WEEKLY', 30: 'LEGACY_30_DAYS' })[o.intervalDays] || 'UNKNOWN';
    return {
      id: d.id, toAccount: o.toAccount, amount: o.amount, frequency,
      nextRunAt: o.nextRunAt.toDate(), active: o.active !== false,
      lastStatus: o.lastStatus || null, lastError: o.lastError || null,
      lastRunAt: o.lastRunAt ? o.lastRunAt.toDate() : null,
      failedAttempts: o.failedAttempts || 0,
      lastTxId: o.lastTxId || null,
    };
  }));
}));
app.delete('/api/standing-orders/:id', auth, wrap(async (req, res) => {
  const ref = db.doc(`standingOrders/${req.params.id}`);
  const s = await ref.get();
  if (!s.exists || s.data().ownerUid !== req.user.uid) throw ledger.err(404, 'Not found');
  if (s.data().active !== false) {
    await ref.update({ active: false, canceledAt: FieldValue.serverTimestamp() });
  }
  res.json({ ok: true });
}));

// ---- Admin (role = admin) ----
app.get('/api/admin/stats', auth, requireRole('admin'), wrap(async (req, res) => {
  const [a, t, recent] = await Promise.all([
    db.collection('accounts').count().get(), db.collection('transactions').count().get(),
    db.collection('transactions').orderBy('createdAt', 'desc').limit(10).get(),
  ]);
  res.json({ accounts: a.data().count, transactions: t.data().count,
    recent: recent.docs.map((d) => { const x = d.data(); return { txId: d.id, type: x.type, amount: x.amount, from: x.fromAccount, to: x.toAccount, createdAt: x.createdAt.toDate() }; }) });
}));
app.get('/api/admin/fraud-alerts', auth, requireRole('admin'), wrap(async (req, res) => {
  const recent = await db.collection('transactions').orderBy('createdAt', 'desc').limit(100).get();
  res.json(recent.docs.flatMap((d) => {
    const t = d.data();
    if (!t.risk || t.risk.level === 'LOW') return [];
    return [{
      txId: d.id, fromAccount: t.fromAccount, toAccount: t.toAccount, amount: t.amount,
      createdAt: t.createdAt.toDate(), risk: t.risk,
    }];
  }));
}));
app.get('/api/admin/users', auth, requireRole('admin'), wrap(async (req, res) => {
  const pageToken = req.query.pageToken ? String(req.query.pageToken) : undefined;
  if (pageToken && pageToken.length > 2048) throw ledger.err(400, 'Invalid page token');
  const page = await admin.auth().listUsers(100, pageToken);
  res.json({
    users: page.users.map((user) => ({
      uid: user.uid, email: user.email || '', displayName: user.displayName || '',
      role: user.customClaims?.role === 'admin' ? 'admin' : 'customer',
      disabled: user.disabled, createdAt: user.metadata.creationTime,
    })),
    nextPageToken: page.pageToken || null,
  });
}));
app.patch('/api/admin/users/:uid/role', auth, requireRole('admin'), wrap(async (req, res) => {
  const { uid } = req.params;
  const { role } = req.body;
  if (!uid || uid.length > 128) throw ledger.err(400, 'Invalid user ID');
  if (!['admin', 'customer'].includes(role)) throw ledger.err(400, 'Role must be admin or customer');
  if (uid === req.user.uid && role !== 'admin') throw ledger.err(400, 'You cannot remove your own administrator role');

  let target;
  try { target = await admin.auth().getUser(uid); }
  catch (e) {
    if (e.code === 'auth/user-not-found') throw ledger.err(404, 'User not found');
    throw e;
  }
  const currentRole = target.customClaims?.role === 'admin' ? 'admin' : 'customer';
  if (currentRole === role) return res.json({ uid, role, changed: false });

  if (currentRole === 'admin') {
    let administratorCount = 0, pageToken;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      administratorCount += page.users.filter((user) => user.customClaims?.role === 'admin').length;
      pageToken = page.pageToken;
    } while (pageToken && administratorCount < 2);
    if (administratorCount < 2) throw ledger.err(409, 'At least one administrator must remain');
  }

  await admin.auth().setCustomUserClaims(target.uid, { ...target.customClaims, role });
  res.json({ uid, role, changed: true });
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Cloud Bank API listening on ${port}`));
