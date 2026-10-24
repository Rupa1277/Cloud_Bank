# Cloud Bank Project Guide

## Purpose

Cloud Bank is an academic demonstration of a serverless, event-driven digital banking application on Google Cloud Platform (GCP). Customers can create accounts, view simulated balances, transfer simulated funds, review transaction history, generate statements, and schedule recurring payments. Administrators can review platform activity, user roles, and rule-based transfer risk signals.

**This application uses simulated money only. It is not connected to real banks or payment rails, and its fraud-risk rules are not a production fraud model.**

This document is intended to give future developers and AI coding assistants project context before they suggest or make changes. Keep this guide and the repository README aligned when deployment behavior changes.

## High-level architecture

```text
Customer browser
  ├── Firebase Authentication (email/password; issues Firebase ID tokens)
  └── Firebase Hosting (React/Vite frontend; HTTPS)
        └── /api/** rewrite
              └── Cloud Run: Express API
                    ├── Firebase Admin verifies the ID token
                    ├── Firestore stores accounts, transactions, idempotency, risk history,
                    │   statements, standing orders, and notifications
                    └── Pub/Sub publishes committed transaction/statement events
                          ├── notifyFunction → Firestore in-app notifications
                          ├── auditFunction → BigQuery audit table → Looker Studio
                          ├── statementFunction → PDF → private Cloud Storage
                          └── scheduledFunction ← scheduled-jobs topic
                                └── recurring transfers and monthly statement requests
```

Cloud Run and Cloud Functions are configured to scale from zero. IAM service accounts are separated by component. Firebase Hosting forwards `/api/**` requests to Cloud Run. The client does not access Firestore directly; Firestore rules deny client-side database access.

## Current user-facing features

### Customer

- Sign up and sign in with Firebase email/password authentication.
- Initialize an account with a simulated INR 10,000 welcome balance.
- View account details and balance.
- Transfer simulated funds to another Cloud Bank account.
- Deposit and withdraw simulated funds.
- View the latest 50 transactions, with the customer's own risk signal shown only on outgoing transfers.
- See in-app transaction notifications.
- Request monthly PDF statements and download ready statements using time-limited signed URLs.
- Create, view, and cancel recurring standing orders.
- Review personal transfer-risk alerts in the **Security** view.
- Log out.

### Administrator

- Administrator access comes from a Firebase custom claim (`role=admin`).
- View account/transaction totals and recent transactions.
- Review recent non-low risk transfer signals in the **Admin** view.
- List users with pagination and grant/remove administrator roles.
- Open a Looker Studio report when `VITE_LOOKER_STUDIO_URL` is configured.
- Admin API routes require the admin role; customers should receive HTTP 403 for those routes.

The app's current React components are concentrated in `frontend/src/App.jsx`. The visual design was refreshed toward the `cloudbank-v2` reference while retaining the current app's existing banking interactions.

## Fraud-risk showcase

The current fraud feature is a deterministic, explainable **rule-based signal**, not machine learning. It is used to showcase how transaction context can be scored and audited.

### Current inputs and rules

Risk assessment is performed in the backend transfer path using:

- Transfer amount.
- Up to 20 recent outgoing transfer records for the sender.
- A 24-hour history window.
- Whether the recipient appears in that recent history.
- Whether multiple transfers have occurred in the last five minutes.

Current scoring:

| Signal | Score added |
|---|---:|
| Transfer amount is INR 50,000 or more | 60 |
| Otherwise, amount is INR 25,000 or more | 40 |
| At least 3 prior records exist and this transfer is at least INR 5,000 and 3x their average | 35 |
| At least 2 prior transfers occurred in the last 5 minutes | 35 |
| First transfer to this recipient in the stored recent activity window | 10 |

The score is capped at 100. Levels are `LOW` (0–29), `MEDIUM` (30–59), and `HIGH` (60–100). Reasons are returned and persisted with the transfer.

### Behavior and presentation

- Risk assessment does **not** block, delay, or reject a valid transfer.
- The successful response retains normal transfer status and includes a `risk` object.
- Risk history is updated atomically with the completed transfer and idempotency record.
- The Security view shows flagged outgoing transfers returned in the user's transaction history.
- Admin risk alerts are restricted to administrators and scan the latest 100 transactions for non-low risk records.
- The BigQuery audit event includes `risk_score`, `risk_level`, and `risk_reasons`.
- Risk alerts are informational. They are not proof of fraud and should not be presented as a reliable fraud verdict.

### Suggested manual demonstration

1. Create/sign in to two test accounts and note the recipient's account number.
2. Use the simulated deposit function to give the sender enough balance for the desired test.
3. Send INR 50,000 or more to produce a high-value signal, if account balance permits.
4. Review the transfer response and the sender's Security view.
5. Sign in as an administrator to review recent non-low signals in Admin.
6. For a repeated-transfer demonstration, make multiple outgoing transfers within five minutes.

Deposits, withdrawals, transfers, and welcome balances are simulated; clearly state this during demonstrations.

## Important data and transaction behavior

- All amounts are stored as integer paise (100 paise = INR 1).
- The maximum amount per ledger operation is INR 1,00,000.
- Transfers update sender and recipient balances, write a transaction, save an idempotency response/event, and update sender risk history inside one Firestore transaction.
- Idempotency is operation-scoped and hashed. Retrying the same request should return the prior result and must not debit twice.
- Pub/Sub publishing occurs after the Firestore transaction commits. The API logs publish errors and keeps the successful money operation response; a crash between commit and publish can lose an event. A production-grade transactional outbox is a known future improvement.
- Pub/Sub delivery is at least once; function handlers should remain safe against duplicate delivery.
- Account statements are private in Cloud Storage; downloads are provided through short-lived signed URLs.
- The account number lookup uses a Firestore query. There is no KYC or external bank rail integration.

## Repository map

| Path | Responsibility |
|---|---|
| `frontend/src/App.jsx` | React UI: login, customer dashboard, transfer, history, Security, statements, standing orders, and Admin. |
| `frontend/src/styles.css` | App styling, responsive layouts, and the v2-inspired visual treatment. |
| `frontend/src/api.js` | Authenticated API requests and INR/date formatting. |
| `frontend/src/firebase.js` | Firebase Web SDK initialization from Vite environment variables. |
| `frontend/.env.example` | Names of required frontend Firebase variables and optional Looker URL. Do not copy real credentials into documentation. |
| `backend/src/server.js` | Express API, Firebase token verification, account/admin endpoints, Pub/Sub publishing, and API-to-ledger integration. |
| `shared/ledger.js` | Canonical Firestore ledger implementation shared by the Cloud Run API and scheduled worker; includes idempotency and risk scoring. |
| `backend/src/ledger.js` | Deployment/test copy of the shared ledger. Deployment scripts copy `shared/ledger.js` here. |
| `functions/ledger.js` | Deployment copy of the shared ledger used by scheduled transfers. |
| `functions/index.js` | Pub/Sub workers for notifications, BigQuery audit, PDF statements, and scheduled jobs. |
| `backend/test/ledger.test.js` | Node built-in tests for ledger behavior, idempotency, and fraud-risk scoring. |
| `firestore/firestore.rules` | Firestore rules that deny direct client access. |
| `firebase.json` | Firebase Hosting `/api/**` rewrite and Firestore rules configuration. |
| `scripts/01-setup-gcp.sh` | Enables APIs, configures Firestore/indexes, Pub/Sub, Storage, BigQuery, IAM, and Secret Manager. |
| `scripts/02-deploy-backend.sh` | Copies the shared ledger, builds the backend container, deploys Cloud Run. |
| `scripts/03-deploy-functions.sh` | Copies the shared ledger, deploys Cloud Functions and creates/updates Scheduler jobs. |
| `scripts/04-deploy-frontend.sh` | Builds the frontend and deploys Hosting plus Firestore rules. |
| `scripts/config.sh` | Shared GCP project/region/resource naming. Default region is `asia-south1`. |
| `scripts/audit_schema.json` | BigQuery audit table schema, including transfer-risk fields. |
| `docs/BRD_TRACEABILITY.md` | BRD requirement-to-code traceability. |
| `README.md` | Setup, deployment, demo, troubleshooting, and cost guidance. |

The ledger copies should remain identical. Change `shared/ledger.js` first, then run the deployment scripts or copy it to the backend/function source before validating those copies.

## API overview

All application API routes except `/api/health` require a valid Firebase ID token in the `Authorization: Bearer <token>` header.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | API health check. |
| POST | `/api/account/init` | Create the authenticated user's account if missing and initialize a customer role claim. |
| GET | `/api/account` | Fetch the current user's account. |
| POST | `/api/transfer` | Atomic peer-to-peer transfer; requires an `Idempotency-Key`. |
| POST | `/api/deposit` | Simulated deposit; requires an `Idempotency-Key`. |
| POST | `/api/withdraw` | Simulated withdrawal; requires an `Idempotency-Key`. |
| GET | `/api/transactions` | Current user's latest 50 transactions. |
| GET | `/api/notifications` | Current user's latest in-app notifications. |
| POST | `/api/statements` | Request a PDF statement for a `YYYY-MM` month. |
| GET | `/api/statements` | List the current user's recent statements. |
| GET | `/api/statements/:id/download` | Get a signed download URL for a ready statement owned by the current user. |
| POST | `/api/standing-orders` | Create a recurring transfer (interval 1, 7, or 30 days). |
| GET | `/api/standing-orders` | List the current user's standing orders. |
| DELETE | `/api/standing-orders/:id` | Cancel the current user's standing order. |
| GET | `/api/admin/stats` | Admin-only platform summary. |
| GET | `/api/admin/fraud-alerts` | Admin-only non-low risk signals in the latest 100 transactions. |
| GET | `/api/admin/users` | Admin-only paginated user list. |
| PATCH | `/api/admin/users/:uid/role` | Admin-only customer/admin role change. |

## GCP components and event topics

| Component | Role |
|---|---|
| Firebase Authentication | Customer login and ID tokens. |
| Firebase Hosting | Static frontend hosting and API rewrite. |
| Cloud Run (`bank-api`) | Authenticated Express API; configured with min instances 0 and max instances 10. |
| Firestore | Account ledger, transaction history, idempotency, risk history, statements, orders, and notifications. |
| Pub/Sub `transaction-completed` | Fans transaction events out to notifications and audit subscribers. |
| Pub/Sub `statement-requests` | Triggers statement PDF generation. |
| Pub/Sub `scheduled-jobs` | Receives recurring-payment and monthly-statement job events from Cloud Scheduler. |
| Cloud Functions gen2 | `notifyFunction`, `auditFunction`, `statementFunction`, and `scheduledFunction`; independently scalable. |
| Cloud Storage | Private generated PDF statements. |
| BigQuery | `cloudbank_audit.transactions_audit`, including transfer risk fields. |
| Cloud Scheduler | Daily recurring-payment job and monthly statement job. |
| Secret Manager | Optional notification webhook secret; no secret values belong in source control. |
| Looker Studio | Optional dashboard connected to BigQuery audit data. |

## Local development and validation

### Frontend only

From PowerShell:

```powershell
cd C:\path\to\cloudbank\frontend
npm install
Copy-Item .env.example .env
# Edit .env with your own Firebase Web app configuration.
npm run dev
```

Vite prints the local URL, usually `http://localhost:5173`. The frontend can render locally, but the current Vite configuration does not proxy `/api` requests to a local backend. Authentication and banking features require the configured Firebase project and an available Cloud Run API.

### Build and backend tests

```powershell
cd C:\path\to\cloudbank\frontend
npm run build

cd C:\path\to\cloudbank\backend
node --test
```

The backend ledger tests use a fake Firestore implementation; they do not connect to GCP or prove a cloud deployment is configured.

## GCP deployment overview

The detailed current commands and account setup are in `README.md`. Deployment requires a GCP project with billing and the needed project permissions, Firebase configured for that same project, and Firebase Email/Password Authentication enabled.

From Cloud Shell (Linux shell):

1. Set `GCP_PROJECT_ID` to the intended project.
2. Run `scripts/01-setup-gcp.sh` to provision/enable GCP resources and IAM.
3. Run `scripts/02-deploy-backend.sh` to build/deploy Cloud Run.
4. Run `scripts/03-deploy-functions.sh` to deploy functions and scheduler jobs.
5. Create `frontend/.env` with the Firebase Web app configuration and optional Looker Studio URL.
6. Run `scripts/04-deploy-frontend.sh` to build and deploy Hosting and Firestore rules.
7. Create/sign in to customer test users. Bootstrap an admin only after a user exists, using the `scripts/set-admin.js` utility described in the README.

### Important BigQuery schema migration note

The audit schema now contains `risk_score`, `risk_level`, and `risk_reasons`. BigQuery does not permit removing or changing arbitrary existing fields through `bq update --schema`; adding new nullable fields is normally compatible. If updating an existing table fails, inspect its schema and apply a supported additive schema update rather than dropping or recreating the audit table (which could destroy audit history). Validate the exact GCP CLI behavior before running provisioning commands on a project with existing data.

Never run teardown or destructive data/resource operations without explicit human approval and a backup/impact check.

## Security, privacy, and cost guardrails

- Use only test accounts and simulated funds for demos.
- Do not commit `.env`, service-account key files, webhook URLs, access tokens, or other secrets.
- Firebase Web configuration is supplied to Vite through local environment variables; do not paste its values into guides, prompts, screenshots, or public issue comments.
- Firebase ID tokens are verified server-side. Do not trust role values or account identifiers supplied by the browser.
- Keep admin routes protected by server-side custom-claim checks; hiding a frontend tab is not authorization.
- Preserve transaction atomicity and idempotency on all money-moving code paths.
- Do not automatically block customers based solely on this demo risk score.
- Minimize personal information in logs and BigQuery. Treat user IDs and account numbers as sensitive identifiers.
- Review GCP billing and set an appropriate budget alert before provisioning. Cloud services may incur charges; scale-to-zero does not guarantee the entire project has zero cost.
- Do not deploy or run GCP setup scripts without the project owner's confirmation and awareness of the resources/permissions they change.

## Instructions for future GPT-assisted work

Use this project context before proposing code or commands:

1. Preserve all existing customer/admin features unless the project owner explicitly asks to remove a feature.
2. Maintain the v2-inspired UI language: teal/jade surfaces, dark navigation rail, clear cards, compact status badges, accessible focus states, and responsive layouts. Prefer incremental improvements over a wholesale redesign.
3. Keep ledger amounts as integer paise and preserve Firestore ACID transactions and idempotent retries.
4. Update the canonical `shared/ledger.js` first; keep deployment copies synchronized.
5. Keep customer data scoped to the authenticated UID and admin functionality server-authorized.
6. Fraud scoring is an explainable academic demo only. Clearly describe rule changes, keep the non-blocking behavior unless explicitly approved otherwise, and never call the result a verified fraud finding or production model.
7. If transaction fields change, update all impacted API responses, Pub/Sub consumers, BigQuery schema, docs, tests, and UI. Preserve existing audit data and prefer additive schema changes.
8. Before deployment, explain what GCP resources, permissions, costs, or data changes a command may cause. Do not deploy, change IAM, enable billing, delete data/resources, or invoke teardown without explicit approval.
9. Do not reveal or copy secrets from local files. Refer to variable names/placeholders only.
10. Run at least `npm run build` in `frontend` and `node --test` in `backend` for relevant changes. Add focused tests for ledger/risk changes and report validation results accurately.
11. Do not push, commit, or open a pull request unless specifically asked.

## Known limitations and future improvements

- The fraud system is rule-based, deterministic, not calibrated on real data, and should not be used to make real customer decisions.
- Admin alerts scan only the latest 100 transaction records.
- Risk history keeps the latest 20 outgoing transfers within a rolling 24-hour window.
- Transfers complete even when a risk level is HIGH; there is no review/hold workflow.
- No MFA, KYC, external bank rails, or real-money processing.
- Pub/Sub publish occurs after the ledger commit; a transactional outbox would improve reliability.
- Local frontend development currently has no Vite `/api` proxy or local backend emulator setup.
- BigQuery insert de-duplication via `insertId` is best effort, not a replacement for a fully idempotent audit pipeline.
- Cost targets depend on usage, quotas, region, free-tier eligibility, and retained resources; verify actual billing rather than assuming zero cost.
