// Cloud Bank async workers. Each one is a separate function with its own service account,
// triggered by Pub/Sub, and scales independently from the API and from each other (FR-06).
const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { BigQuery } = require('@google-cloud/bigquery');
const { PubSub } = require('@google-cloud/pubsub');
const { Storage } = require('@google-cloud/storage');
const PDFDocument = require('pdfkit');
const ledger = require('./ledger');

admin.initializeApp();
const db = admin.firestore();
const bigquery = new BigQuery();
const pubsub = new PubSub();
const storage = new Storage();
const BUCKET = process.env.STATEMENT_BUCKET;
const DATASET = process.env.BQ_DATASET || 'cloudbank_audit';
const TABLE = process.env.BQ_TABLE || 'transactions_audit';
const TOPIC_TX = process.env.TOPIC_TX || 'transaction-completed';
const TOPIC_STMT = process.env.TOPIC_STMT || 'statement-requests';

const decode = (ce) => JSON.parse(Buffer.from(ce.data.message.data, 'base64').toString());
const inr = (p) => (p / 100).toFixed(2);

// 1) NOTIFICATIONS: in-app notification for each party (+ optional webhook stored in Secret Manager)
functions.cloudEvent('notifyFunction', async (ce) => {
  const e = decode(ce);
  const msgs = [];
  if (e.type === 'TRANSFER') {
    msgs.push([e.fromUid, `You sent INR ${inr(e.amount)} to ${e.toAccount}`]);
    msgs.push([e.toUid, `You received INR ${inr(e.amount)} from ${e.fromAccount}`]);
  } else if (e.type === 'DEPOSIT') msgs.push([e.toUid, `INR ${inr(e.amount)} deposited to your account`]);
  else if (e.type === 'WITHDRAWAL') msgs.push([e.fromUid, `INR ${inr(e.amount)} withdrawn from your account`]);
  // doc id = txId -> Pub/Sub at-least-once delivery cannot create duplicates
  await Promise.all(msgs.map(([uid, message]) =>
    db.doc(`users/${uid}/notifications/${e.txId}`).set({ message, txId: e.txId, createdAt: FieldValue.serverTimestamp() })));
  const hook = process.env.NOTIFY_WEBHOOK_URL;
  if (hook && hook.startsWith('http')) {
    await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msgs.map((m) => m[1]).join(' | '), text: msgs.map((m) => m[1]).join(' | ') }) }).catch((x) => console.error('webhook failed', x.message));
  }
  console.log(`notified ${msgs.length} user(s) for ${e.txId}`);
});

// 2) AUDIT: stream every transaction into BigQuery (Looker Studio reads this table)
functions.cloudEvent('auditFunction', async (ce) => {
  const e = decode(ce);
  const row = { tx_id: e.txId, type: e.type, from_uid: e.fromUid || null, to_uid: e.toUid || null,
    from_account: e.fromAccount, to_account: e.toAccount, amount_paise: e.amount, source: e.source || 'API',
    risk_score: e.risk?.score ?? 0, risk_level: e.risk?.level || 'LOW',
    risk_reasons: e.risk?.reasons?.join(' | ') || '',
    occurred_at: e.occurredAt, ingested_at: new Date().toISOString() };
  await bigquery.dataset(DATASET).table(TABLE).insert([{ insertId: e.txId, json: row }], { raw: true });  // insertId = best-effort de-dup
  console.log(`audit row written for ${e.txId}`);
});

// 3) STATEMENTS: build a PDF, store it privately in Cloud Storage
function buildPdf({ acc, month, rows, uid }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(20).text('Cloud Bank - Account Statement');
    doc.moveDown(0.5).fontSize(11).text(`Account holder: ${acc.ownerName}`).text(`Account number: ${acc.accountNumber}`)
      .text(`Statement month: ${month} (UTC)`).text(`Closing balance (current): INR ${inr(acc.balance)}`).moveDown();
    let credits = 0, debits = 0;
    doc.fontSize(10).text('Date                      Type          Counterparty        Debit        Credit', { underline: true });
    for (const t of rows) {
      const debit = t.fromUid === uid; const amt = t.amount;
      if (debit) debits += amt; else credits += amt;
      if (doc.y > 720) doc.addPage();
      doc.text(`${t.createdAt.toDate().toISOString().slice(0, 16).replace('T', ' ')}   ${t.type.padEnd(11)}  ${String(debit ? t.toAccount : t.fromAccount).padEnd(16)}  ${debit ? inr(amt).padStart(10) : ''.padStart(10)}   ${debit ? '' : inr(amt).padStart(10)}`);
    }
    doc.moveDown().fontSize(11).text(`Total debits: INR ${inr(debits)}    Total credits: INR ${inr(credits)}    Transactions: ${rows.length}`);
    doc.end();
  });
}
async function makeStatement({ uid, statementId, month }) {
  const sRef = db.doc(`users/${uid}/statements/${statementId}`);
  try {
    const [y, m] = month.split('-').map(Number);
    const start = Timestamp.fromDate(new Date(Date.UTC(y, m - 1, 1)));
    const end = Timestamp.fromDate(new Date(Date.UTC(y, m, 1)));
    const acc = (await db.doc(`accounts/${uid}`).get()).data();
    const snap = await db.collection('transactions').where('participants', 'array-contains', uid)
      .where('createdAt', '>=', start).where('createdAt', '<', end).orderBy('createdAt', 'desc').get();
    const pdf = await buildPdf({ acc, month, rows: snap.docs.map((d) => d.data()).reverse(), uid });
    const path = `statements/${uid}/${statementId}.pdf`;
    await storage.bucket(BUCKET).file(path).save(pdf, { contentType: 'application/pdf', resumable: false });
    await sRef.update({ status: 'READY', path, txCount: snap.size, generatedAt: FieldValue.serverTimestamp() });
    console.log(`statement ${statementId} ready (${snap.size} tx)`);
  } catch (e) {
    console.error('statement failed', e);
    await sRef.update({ status: 'FAILED', error: String(e.message).slice(0, 200) }).catch(() => {});
  }
}
functions.cloudEvent('statementFunction', async (ce) => makeStatement(decode(ce)));

// 4) SCHEDULED JOBS (FR-07): Cloud Scheduler publishes {"job": "..."} to the event bus
functions.cloudEvent('scheduledFunction', async (ce) => {
  const { job } = decode(ce);
  if (job === 'recurring-payments') {
    const due = await db.collection('standingOrders').where('nextRunAt', '<=', Timestamp.now()).get();
    for (const doc of due.docs) {
      const o = doc.data(); if (!o.active) continue;
      const key = `so_${doc.id}_${o.nextRunAt.toDate().toISOString().slice(0, 10)}`;   // one run per order per day, even if the job re-runs
      let status = 'OK';
      try {
        const r = await ledger.transfer(db, { fromUid: o.ownerUid, toAccountNumber: o.toAccount, amount: o.amount,
          note: 'Standing order', idempotencyKey: key, source: 'SCHEDULER' });
        if (r.event) await pubsub.topic(TOPIC_TX).publishMessage({ json: r.event });
      } catch (e) { status = `FAILED: ${e.message}`; }
      await doc.ref.update({ nextRunAt: Timestamp.fromMillis(o.nextRunAt.toMillis() + o.intervalDays * 86400000), lastStatus: status, lastRunAt: Timestamp.now() });
    }
    console.log(`recurring payments processed: ${due.size}`);
  } else if (job === 'monthly-statements') {
    const now = new Date(); const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    const accounts = await db.collection('accounts').select().get();
    for (const a of accounts.docs) {
      const ref = db.collection(`users/${a.id}/statements`).doc();
      await ref.set({ month, status: 'PENDING', createdAt: FieldValue.serverTimestamp(), auto: true });
      await pubsub.topic(TOPIC_STMT).publishMessage({ json: { uid: a.id, statementId: ref.id, month } });
    }
    console.log(`monthly statements requested for ${accounts.size} accounts (${month})`);
  } else console.warn('unknown job', job);
});
