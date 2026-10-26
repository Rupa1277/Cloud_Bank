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
| Fraud-detection showcase | `shared/ledger.js` stores explainable rule-based transfer risk scores; customer Security view and admin alerts display flagged completed transfers; `functions/index.js` includes risk fields in BigQuery audit rows. The Admin live-demo UI and `loadtest/simulate-fraud.js` display the actual completed transactions and their risk explanations. Informational only; no automatic blocking or ML model. |
| Fraud demo endpoint | `POST /api/demo/simulate-fraud` in `backend/src/server.js` requires admin auth and `DEMO_FRAUD_SIMULATION_ENABLED=true`; it issues three idempotent serial transfers through `shared/ledger.js`, then publishes their events to `transaction-completed`. Disabled by default. |
| Recurring schedule calculation | `shared/recurrence.js` (deployed to `functions/recurrence.js` by `scripts/03-deploy-functions.sh`) calculates daily, weekly, calendar-month, and legacy interval occurrences; tested in `backend/test/recurrence.test.js`. |
| NFR scale 0→N | Cloud Run `--min-instances 0 --max-instances 10`; functions `--min-instances 0 --max-instances 5` |
| NFR secrets | Secret Manager `notify-webhook-url` |
| NFR IAM | 5 service accounts in scripts/01-setup-gcp.sh |
| NFR deployment | `gcloud builds submit` + `gcloud run deploy` in scripts/02 |
