# BRD → implementation map
| ID | Where |
|---|---|
| FR-01 | `backend/src/server.js` auth(), Firebase Auth in `frontend/src/firebase.js` |
| FR-02 | Firebase custom claims in `/api/account/init`; bootstrap with `scripts/set-admin.js`; admin-only user listing and role changes in `/api/admin/users` and the Admin tab |
| FR-03 | `shared/ledger.js` transfer() |
| FR-04 | Operation-scoped hashed idempotency documents in `shared/ledger.js`, with legacy-key compatibility |
| FR-05 | `/api/transfer` → publish → 200; event payload is retained with the idempotency record so client retries can republish after transient Pub/Sub failures |
| FR-06 | functions/index.js: notifyFunction, auditFunction, statementFunction (independent subscribers/topics) |
| FR-07 | Cloud Scheduler jobs (scripts/03) → topic `scheduled-jobs` → scheduledFunction |
| FR-08 | statementFunction → private bucket; `/api/statements/:id/download` signed URL |
| FR-09 | BigQuery `cloudbank_audit.transactions_audit` → Looker Studio (README §4); admin UI link configured with `VITE_LOOKER_STUDIO_URL` |
| Fraud-detection showcase | `shared/ledger.js` stores explainable rule-based transfer risk scores; customer Security view and admin alerts display flagged completed transfers; `functions/index.js` includes risk fields in BigQuery audit rows. Informational only; no automatic blocking or ML model. |
| NFR scale 0→N | Cloud Run `--min-instances 0 --max-instances 10`; functions `--min-instances 0 --max-instances 5` |
| NFR secrets | Secret Manager `notify-webhook-url` |
| NFR IAM | 5 service accounts in scripts/01-setup-gcp.sh |
| NFR deployment | `gcloud builds submit` + `gcloud run deploy` in scripts/02 |
