# BRD → implementation map
| ID | Where |
|---|---|
| FR-01 | `backend/src/server.js` auth(), Firebase Auth in `frontend/src/firebase.js` |
| FR-02 | Firebase custom claims in `/api/account/init`; bootstrap with `scripts/set-admin.js`; admin-only user listing and role changes in `/api/admin/users` and the Admin tab |
| FR-03 | `shared/ledger.js` transfer() |
| FR-04 | Operation-scoped hashed idempotency documents in `shared/ledger.js`, with legacy-key compatibility |
| FR-05 | `/api/transfer` → publish → 200; event payload is retained with the idempotency record so client retries can republish after transient Pub/Sub failures |
| FR-06 | functions/index.js: notifyFunction, auditFunction, statementFunction (independent subscribers/topics) |
| FR-07 | Cloud Scheduler jobs (`scripts/03-deploy-functions.sh`) → topic `scheduled-jobs` → `scheduledFunction`; daily/weekly/monthly standing orders use the atomic ledger transfer and per-occurrence idempotency; failed occurrences remain due for retry; monthly recurrence preserves day-of-month. |
| FR-08 | statementFunction → private bucket; `/api/statements/:id/download` signed URL |
| FR-09 | BigQuery `cloudbank_audit.transactions_audit` → Looker Studio (README §4); admin UI link configured with `VITE_LOOKER_STUDIO_URL` |
| Fraud-detection showcase | `shared/ledger.js` stores explainable rule-based transfer risk scores; MEDIUM/HIGH transfers pause before ledger writes for explicit sender approval. Sender declines are persisted and published as audit events without moving money. Customer Security and admin alerts show completed signals; `functions/index.js` streams completed and blocked outcomes to BigQuery. The Admin live demo approves its controlled simulated transfers. Not a validated fraud model. |
| Fraud demo endpoint | `POST /api/demo/simulate-fraud` in `backend/src/server.js` requires admin auth and `DEMO_FRAUD_SIMULATION_ENABLED=true`; it issues three idempotent serial transfers through `shared/ledger.js`, then publishes their events to `transaction-completed`. Disabled by default. |
| KYC account opening | `shared/ledger.js` validates full name, Indian mobile, PAN, and proof format; provisions pending accounts atomically; stores HMAC identifiers/masked values and credits INR 1,000 once on activation. KYC is format-only, not government-verified. |
| Recipient verification | `/api/transfer/verify-recipient` resolves an account number or HMAC-indexed phone and returns only the recipient name and masked account number. The actual transfer resolves the recipient again within the Firestore transaction. |
| Failed transfer audit | A Firestore transaction aborts uncommitted ledger writes. Known failed attempts are recorded in `transferAttempts` and published as `TRANSFER_FAILED`; there is no refund unless a debit actually committed and a separate compensating credit is required. |
| Recurring schedule calculation | `shared/recurrence.js` (deployed to `functions/recurrence.js` by `scripts/03-deploy-functions.sh`) calculates daily, weekly, calendar-month, and legacy interval occurrences; tested in `backend/test/recurrence.test.js`. |
| NFR scale 0→N | Cloud Run `--min-instances 0 --max-instances 10`; functions `--min-instances 0 --max-instances 5` |
| NFR secrets | Secret Manager `notify-webhook-url` |
| NFR IAM | 5 service accounts in scripts/01-setup-gcp.sh |
| NFR deployment | `gcloud builds submit` + `gcloud run deploy` in scripts/02 |
