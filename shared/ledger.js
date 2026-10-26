// Core ledger logic. ALL money is stored as integer paise (1 INR = 100 paise): no floating-point errors.
// Used by the Cloud Run API and by the scheduled (recurring payment) Cloud Function.
const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');
const MAX_AMOUNT = 10000000; // INR 1,00,000 per operation
const OPENING_BALANCE = 100000; // simulated INR 1,000 opening balance (paise)
const RISK_HISTORY_LIMIT = 20;
const RISK_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RAPID_TRANSFER_WINDOW_MS = 2 * 60 * 1000;
const PHONE_RE = /^[6-9]\d{9}$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const PROOF_TYPES = new Set(['AADHAAR', 'VOTER_ID', 'PASSPORT']);
const RISK_CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

const err = (status, message) => Object.assign(new Error(message), { status });
const checkAmount = (a) => {
  if (!Number.isInteger(a) || a <= 0) throw err(400, 'Amount must be greater than zero');
  if (a > MAX_AMOUNT) throw err(400, 'Amount exceeds the per-transaction limit of INR 1,00,000');
};

async function findAccountByNumber(db, number) {
  const index = await db.doc(`accountNumbers/${String(number)}`).get();
  if (index.exists) {
    const account = await db.doc(`accounts/${index.data().uid}`).get();
    if (account.exists) return { id: account.id, data: () => account.data() };
  }
  const s = await db.collection('accounts').where('accountNumber', '==', String(number)).limit(1).get();
  return s.empty ? null : s.docs[0];
}

function validateKyc(profile = {}) {
  const values = {
    fullName: String(profile.fullName ?? profile.name ?? '').trim(),
    phone: String(profile.phone ?? '').replace(/\s/g, ''),
    pan: String(profile.pan ?? '').trim().toUpperCase(),
    addressProofType: String(profile.addressProofType ?? '').trim().toUpperCase(),
    addressProofNumber: String(profile.addressProofNumber ?? '').trim().toUpperCase(),
    photoUrl: String(profile.photoUrl ?? '').trim(),
  };
  const errors = [];
  if (values.fullName.length < 2 || values.fullName.length > 80 || /[\u0000-\u001f]/.test(values.fullName)) errors.push('fullName');
  if (!PHONE_RE.test(values.phone)) errors.push('phone');
  if (!PAN_RE.test(values.pan)) errors.push('pan');
  if (!PROOF_TYPES.has(values.addressProofType)) errors.push('addressProofType');
  if (values.addressProofType === 'AADHAAR' && !/^\d{12}$/.test(values.addressProofNumber)) errors.push('addressProofNumber');
  if (values.addressProofType === 'VOTER_ID' && !/^[A-Z]{3}\d{7}$/.test(values.addressProofNumber)) errors.push('addressProofNumber');
  if (values.addressProofType === 'PASSPORT' && !/^[A-PR-WY][0-9]{7}$/.test(values.addressProofNumber)) errors.push('addressProofNumber');
  if (values.photoUrl) {
    try {
      const url = new URL(values.photoUrl);
      if (url.protocol !== 'https:' || url.search || url.hash ||
          !['storage.googleapis.com', 'firebasestorage.googleapis.com'].includes(url.hostname)) {
        errors.push('photoUrl');
      }
    } catch {
      errors.push('photoUrl');
    }
  }
  return { valid: errors.length === 0, errors, values };
}

function hashKycValue(secret, kind, value) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw err(503, 'KYC service is not configured');
  }
  return crypto.createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex');
}

const maskPhone = (phone) => `******${phone.slice(-4)}`;
const maskPan = (pan) => `${pan.slice(0, 2)}******${pan.slice(-2)}`;
const maskProofNumber = (number) => `******${number.slice(-4)}`;
const maskAccountNumber = (number) => `${number.slice(0, 2)}******${number.slice(-4)}`;

function publicAccount(account) {
  const {
    phoneLookupHash, panHash, addressProofHash,
    ...safeAccount
  } = account;
  return safeAccount;
}

async function initializeAccount(db, { uid, email, profile = {}, kycSecret }) {
  const { valid, errors, values } = validateKyc(profile);
  const kyc = valid ? {
    phoneLookupHash: hashKycValue(kycSecret, 'phone', values.phone),
    phoneMasked: maskPhone(values.phone),
    panHash: hashKycValue(kycSecret, 'pan', values.pan),
    panMasked: maskPan(values.pan),
    addressProofType: values.addressProofType,
    addressProofHash: hashKycValue(kycSecret, `address-proof:${values.addressProofType}`, values.addressProofNumber),
    addressProofMasked: maskProofNumber(values.addressProofNumber),
    passportPhotoUrl: values.photoUrl || null,
  } : null;
  const accountRef = db.doc(`accounts/${uid}`);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const accountNumber = `CB${String(crypto.randomInt(0, 1e10)).padStart(10, '0')}`;
    const numberIndexRef = db.doc(`accountNumbers/${accountNumber}`);
    const result = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(accountRef);
      const old = existing.exists ? existing.data() : {};
      const chosenNumber = old.accountNumber || accountNumber;
      const chosenNumberRef = old.accountNumber
        ? db.doc(`accountNumbers/${old.accountNumber}`)
        : numberIndexRef;
      const newPhoneRef = kyc ? db.doc(`phone_to_account/${kyc.phoneLookupHash}`) : null;
      const oldPhoneRef = old.phoneLookupHash && old.phoneLookupHash !== kyc?.phoneLookupHash
        ? db.doc(`phone_to_account/${old.phoneLookupHash}`)
        : null;
      const identifierRefs = kyc
        ? [
          { hash: kyc.panHash, kind: 'pan', previousHash: old.panHash },
          { hash: kyc.addressProofHash, kind: 'address-proof', previousHash: old.addressProofHash },
        ]
        : [];
      const identifierSnapshots = await Promise.all(identifierRefs.map(({ hash }) =>
        transaction.get(db.doc(`kycIdentifiers/${hash}`))));
      const oldIdentifierSnapshots = await Promise.all(identifierRefs.map(({ previousHash, hash }) =>
        previousHash && previousHash !== hash
          ? transaction.get(db.doc(`kycIdentifiers/${previousHash}`))
          : Promise.resolve(null)));
      const [numberIndex, phoneIndex, oldPhoneIndex] = await Promise.all([
        transaction.get(chosenNumberRef),
        newPhoneRef ? transaction.get(newPhoneRef) : Promise.resolve(null),
        oldPhoneRef ? transaction.get(oldPhoneRef) : Promise.resolve(null),
      ]);

      if (numberIndex.exists && numberIndex.data().uid !== uid) {
        if (old.accountNumber) throw err(409, 'Account number is already assigned');
        return { collision: true };
      }
      if (kyc && phoneIndex.exists && phoneIndex.data().uid !== uid) {
        throw err(409, 'This phone number is already linked to another account');
      }
      for (let index = 0; index < identifierRefs.length; index += 1) {
        const identifier = identifierSnapshots[index];
        if (identifier.exists && identifier.data().uid !== uid) {
          throw err(409, `This ${identifierRefs[index].kind === 'pan' ? 'PAN' : 'address proof'} is already linked to another account`);
        }
      }

      const oldBalance = Number.isInteger(old.balance) && old.balance >= 0 ? old.balance : 0;
      const wasActive = old.accountStatus === 'ACTIVE';
      const activate = valid || wasActive;
      const creditOpeningBalance = valid && !wasActive && oldBalance === 0 && !old.openingBalanceCreditedAt;
      const account = {
        ...old,
        ownerName: (valid ? values.fullName : old.ownerName) ||
          String(email || 'user').split('@')[0].slice(0, 80),
        email: email || old.email || null,
        accountNumber: chosenNumber,
        balance: creditOpeningBalance ? OPENING_BALANCE : oldBalance,
        accountStatus: activate ? 'ACTIVE' : 'PENDING_VERIFICATION',
        ...(creditOpeningBalance ? { openingBalanceCreditedAt: FieldValue.serverTimestamp() } : {}),
        ...(kyc ? kyc : {}),
        createdAt: old.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      transaction.set(accountRef, account);
      transaction.set(chosenNumberRef, { uid });
      if (newPhoneRef) transaction.set(newPhoneRef, { uid });
      for (const identifier of identifierRefs) {
        transaction.set(db.doc(`kycIdentifiers/${identifier.hash}`), { uid, kind: identifier.kind });
      }
      if (oldPhoneRef && oldPhoneIndex?.exists && oldPhoneIndex.data().uid === uid) {
        transaction.delete(oldPhoneRef);
      }
      for (let index = 0; index < identifierRefs.length; index += 1) {
        const { previousHash, hash } = identifierRefs[index];
        const previous = oldIdentifierSnapshots[index];
        if (previousHash && previousHash !== hash && previous?.exists && previous.data().uid === uid) {
          transaction.delete(db.doc(`kycIdentifiers/${previousHash}`));
        }
      }
      return { account: publicAccount(account) };
    });

    if (result.collision) continue;
    return { account: result.account, kycErrors: valid ? [] : errors };
  }
  throw err(503, 'Could not allocate an account number; please retry');
}

async function findRecipient(db, { accountNumber, phone, kycSecret }) {
  let accountRef;
  if (accountNumber) {
    const normalized = String(accountNumber).trim().toUpperCase();
    if (!/^CB\d{10}$/.test(normalized)) return null;
    const index = await db.doc(`accountNumbers/${normalized}`).get();
    if (index.exists) accountRef = db.doc(`accounts/${index.data().uid}`);
    else {
      const found = await db.collection('accounts').where('accountNumber', '==', normalized).limit(1).get();
      if (found.empty) return null;
      return found.docs[0];
    }
  } else if (phone) {
    const normalized = String(phone).replace(/\s/g, '');
    if (!PHONE_RE.test(normalized)) return null;
    const phoneHash = hashKycValue(kycSecret, 'phone', normalized);
    const index = await db.doc(`phone_to_account/${phoneHash}`).get();
    if (!index.exists) return null;
    accountRef = db.doc(`accounts/${index.data().uid}`);
  } else {
    return null;
  }
  const account = await accountRef.get();
  return account.exists ? { id: account.id, data: () => account.data() } : null;
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

  // A transfer of INR 50,000 scores HIGH by itself; INR 25,000 starts at MEDIUM.
  if (amount >= 5000000) {
    score += 60;
    reasons.push('High-value transfer (INR 50,000 or more)');
  } else if (amount >= 2500000) {
    score += 40;
    reasons.push('Large transfer (INR 25,000 or more)');
  }

  // Compare against at least three recent transfers to avoid overreacting to sparse history.
  if (history.length >= 3) {
    const average = history.reduce((total, item) => total + item.amount, 0) / history.length;
    if (amount >= 500000 && amount >= average * 3) {
      score += 35;
      reasons.push('Amount is at least 3x your recent transfer average');
    }
  }

  // Two prior outgoing transfers in this two-minute window mean the current transfer is the third rapid transfer.
  // Two prior outgoing transfers make the current one the third transfer in the two-minute demo window.
  const rapidCount = history.filter((item) => item.createdAtMs >= now - RAPID_TRANSFER_WINDOW_MS).length;
  if (rapidCount >= 2) {
    score += 35;
    reasons.push('Multiple transfers within a short time');
  }

  // A new recipient adds context but does not by itself imply suspicious activity.
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

async function getRecipientInTransaction(transaction, db, { toAccountNumber, toPhone, kycSecret }) {
  if (toAccountNumber) {
    const normalized = String(toAccountNumber).trim().toUpperCase();
    if (!/^CB\d{10}$/.test(normalized)) throw err(400, 'Enter a valid recipient account number or phone number');
    const indexRef = db.doc(`accountNumbers/${normalized}`);
    const index = await transaction.get(indexRef);
    if (index.exists) {
      const account = await transaction.get(db.doc(`accounts/${index.data().uid}`));
      return account.exists ? { id: account.id, data: () => account.data() } : null;
    }
    const matches = await transaction.get(
      db.collection('accounts').where('accountNumber', '==', normalized).limit(1),
    );
    return matches.empty ? null : matches.docs[0];
  }
  const normalizedPhone = String(toPhone || '').replace(/\s/g, '');
  if (!PHONE_RE.test(normalizedPhone)) throw err(400, 'Enter a valid recipient account number or phone number');
  const phoneHash = hashKycValue(kycSecret, 'phone', normalizedPhone);
  const index = await transaction.get(db.doc(`phone_to_account/${phoneHash}`));
  if (!index.exists) return null;
  const account = await transaction.get(db.doc(`accounts/${index.data().uid}`));
  return account.exists ? { id: account.id, data: () => account.data() } : null;
}

// Atomic peer-to-peer transfer (FR-03) with idempotency protection (FR-04).
async function transfer(db, {
  fromUid, toAccountNumber, toPhone, kycSecret, amount, note = '', idempotencyKey, source = 'API',
  riskDecision, riskConfirmationId, onFailure,
}) {
  checkAmount(amount);
  if (Boolean(toAccountNumber) === Boolean(toPhone)) {
    throw err(400, 'Provide exactly one recipient account number or phone number');
  }

  const fromRef = db.doc(`accounts/${fromUid}`);
  const riskStateRef = db.doc(`riskSignals/${fromUid}`);
  const idemRefs = idempotencyRefs(db, fromUid, 'transfer', idempotencyKey);
  const confirmationId = crypto.createHash('sha256')
    .update(JSON.stringify([fromUid, 'risk-confirmation', idempotencyKey]))
    .digest('hex');
  const confirmationRef = db.doc(`riskConfirmations/${confirmationId}`);
  if (riskDecision && !['ALLOW', 'BLOCK'].includes(riskDecision)) {
    throw err(400, 'riskDecision must be ALLOW or BLOCK');
  }
  if (riskDecision && riskConfirmationId !== confirmationId) {
    throw err(400, 'A valid riskConfirmationId is required to confirm this transfer');
  }

  try {
    return await db.runTransaction(async (t) => {
    // Read transfer, confirmation, account, and risk state before any writes.
    const [idem, legacyIdem, confirmation, from, riskState] = await Promise.all([
      t.get(idemRefs.current), t.get(idemRefs.legacy), t.get(confirmationRef),
      t.get(fromRef), t.get(riskStateRef),
    ]);
    const existingIdem = idem.exists ? idem : legacyIdem;
    if (existingIdem.exists) return { ...existingIdem.data().response, duplicate: true, event: existingIdem.data().event };   // retry -> same answer, no double charge
    if (riskDecision && !confirmation.exists) throw err(409, 'Risk confirmation was not found; review the transfer again');
    if (confirmation.exists && confirmation.data().status === 'BLOCKED') {
      return { status: 'BLOCKED', blocked: true, risk: confirmation.data().risk };
    }
    if (confirmation.exists && confirmation.data().status === 'COMPLETED') {
      const completed = await t.get(idemRefs.current);
      if (completed.exists) return { ...completed.data().response, duplicate: true, event: completed.data().event };
    }
    if (confirmation.exists && confirmation.data().status !== 'PENDING') {
      return { confirmationExpired: true };
    }
    if (confirmation.exists && confirmation.data().expiresAtMs <= Date.now()) {
      t.update(confirmationRef, { status: 'EXPIRED', updatedAt: FieldValue.serverTimestamp() });
      return { confirmationExpired: true };
    }
    if (!from.exists) throw err(404, 'Your account was not found');
    const recipient = await getRecipientInTransaction(t, db, { toAccountNumber, toPhone, kycSecret });
    if (!recipient) throw err(404, 'Recipient account not found');
    const toUid = recipient.id;
    const toRef = db.doc(`accounts/${toUid}`);
    const to = recipient;
    if (toUid === fromUid) throw err(400, 'You cannot transfer to your own account');
    if (from.data().accountStatus === 'PENDING_VERIFICATION') throw err(403, 'Complete account verification before making transfers');
    if (to.data().accountStatus === 'PENDING_VERIFICATION') throw err(400, 'Recipient account is not active');
    if (from.data().balance < amount) throw err(400, 'Insufficient funds');

    const now = Date.now();
    const recent = riskState.exists && Array.isArray(riskState.data().recent) ? riskState.data().recent : [];
    const risk = assessTransferRisk({ amount, toUid, recent, now });
    const requestFingerprint = crypto.createHash('sha256')
      .update(JSON.stringify([fromUid, toUid, amount, String(note).slice(0, 80), source]))
      .digest('hex');
    const riskFingerprint = crypto.createHash('sha256')
      .update(JSON.stringify([risk.score, risk.level, risk.reasons]))
      .digest('hex');

    if (confirmation.exists && confirmation.data().requestFingerprint !== requestFingerprint) {
      throw err(409, 'Transfer details changed; start a new transfer to review the updated details');
    }
    if (!confirmation.exists && risk.level !== 'LOW') {
      t.set(confirmationRef, {
        status: 'PENDING',
        fromUid, toUid, amount, note: String(note).slice(0, 80), source,
        requestFingerprint, riskFingerprint, risk,
        createdAt: FieldValue.serverTimestamp(),
        expiresAtMs: now + RISK_CONFIRMATION_WINDOW_MS,
      });
      return { status: 'CONFIRMATION_REQUIRED', confirmationRequired: true, confirmationId, risk };
    }
    if (risk.level !== 'LOW' && !riskDecision) {
      return { status: 'CONFIRMATION_REQUIRED', confirmationRequired: true, confirmationId, risk };
    }
    if (riskDecision === 'BLOCK') {
      const event = {
        txId: confirmationId, type: 'TRANSFER_BLOCKED', status: 'BLOCKED',
        fromUid, toUid, fromAccount: from.data().accountNumber, toAccount: to.data().accountNumber,
        amount, source, risk,
        risk_score: risk.score, risk_level: risk.level, risk_reasons: risk.reasons,
        occurredAt: new Date().toISOString(),
      };
      const attemptRef = db.doc(`transferAttempts/${confirmationId}`);
      t.set(attemptRef, {
        ...event, participants: [fromUid, toUid], createdAt: FieldValue.serverTimestamp(),
      });
      t.update(confirmationRef, { status: 'BLOCKED', updatedAt: FieldValue.serverTimestamp() });
      return { status: 'BLOCKED', blocked: true, risk, event };
    }
    if (riskDecision === 'ALLOW' && riskFingerprint !== confirmation.data().riskFingerprint) {
      t.update(confirmationRef, {
        risk, riskFingerprint, updatedAt: FieldValue.serverTimestamp(),
      });
      return { status: 'CONFIRMATION_REQUIRED', confirmationRequired: true, confirmationId, risk, refreshed: true };
    }

    const recentTransfers = recent
      .filter((item) => Number.isFinite(item.createdAtMs) && item.createdAtMs >= now - RISK_HISTORY_WINDOW_MS)
      .concat({ toUid, amount, createdAtMs: now })
      .slice(-RISK_HISTORY_LIMIT);
    const txRef = db.collection('transactions').doc();
    const base = {
      txId: txRef.id, type: 'TRANSFER', fromUid, toUid,
      fromAccount: from.data().accountNumber, toAccount: to.data().accountNumber,
      amount, note: String(note).slice(0, 80), source, risk,
      risk_score: risk.score, risk_level: risk.level, risk_reasons: risk.reasons,
    };
    t.update(fromRef, { balance: FieldValue.increment(-amount) });
    t.update(toRef, { balance: FieldValue.increment(amount) });
    t.set(txRef, { ...base, participants: [fromUid, toUid], status: 'COMPLETED', createdAt: FieldValue.serverTimestamp() });
    const response = { txId: txRef.id, status: 'COMPLETED', amount, toAccount: base.toAccount, newBalance: from.data().balance - amount, risk };
    const event = { ...base, occurredAt: new Date().toISOString() };
    t.set(idemRefs.current, { response, event, createdAt: FieldValue.serverTimestamp() });
    t.set(riskStateRef, { recent: recentTransfers, updatedAt: FieldValue.serverTimestamp() });
    if (confirmation.exists) {
      t.update(confirmationRef, { status: 'COMPLETED', txId: txRef.id, updatedAt: FieldValue.serverTimestamp() });
    }
    return { ...response, event };
  });
  } catch (failure) {
    const knownFailure = Number.isInteger(failure.status);
    const attemptId = crypto.createHash('sha256')
      .update(JSON.stringify([fromUid, 'transfer-attempt', idempotencyKey]))
      .digest('hex');
    const attemptRef = db.doc(`transferAttempts/${attemptId}`);
    const event = {
      txId: attemptId,
      type: knownFailure ? 'TRANSFER_FAILED' : 'TRANSFER_OUTCOME_UNKNOWN',
      status: knownFailure ? 'FAILED' : 'UNKNOWN',
      fromUid, toUid: null, fromAccount: null, toAccount: toAccountNumber || null,
      amount, source, failureCode: knownFailure ? `HTTP_${failure.status}` : 'OUTCOME_UNKNOWN',
      occurredAt: new Date().toISOString(),
    };
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(attemptRef);
      if (!existing.exists) {
        transaction.set(attemptRef, { ...event, participants: [fromUid], createdAt: FieldValue.serverTimestamp() });
      }
    });
    if (onFailure) await onFailure(event);
    throw failure;
  }
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

module.exports = {
  transfer, cash, findAccountByNumber, findRecipient, initializeAccount, publicAccount,
  validateKyc, assessTransferRisk, idempotencyRefs, err, MAX_AMOUNT, OPENING_BALANCE, maskAccountNumber,
};
