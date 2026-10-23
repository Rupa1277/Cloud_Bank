# Cloud Bank: Serverless Event-Driven Digital Banking Platform (GCP)

100% serverless: **Firebase Hosting + Auth → Cloud Run API → Firestore (atomic ledger) → Pub/Sub → Cloud Functions → BigQuery / Cloud Storage**,
with Cloud Scheduler, Secret Manager, least-privilege IAM and Looker Studio. No VMs. Scales to zero. (Simulated money only.)

```
Browser ──► Firebase Hosting (CDN, HTTPS) ──/api/**──► Cloud Run: bank-api (0..10 instances)
   ▲ login (JWT)                                          │ 1. verify JWT   2. Firestore transaction (debit+credit+ledger+idempotency key)
Firebase Auth                                             │ 3. publish transaction.completed → return 200 immediately
                                                          ▼
                                   Pub/Sub topic: transaction-completed ──► notifyFunction  → Firestore notifications (+ webhook secret)
                                                                       └──► auditFunction   → BigQuery → Looker Studio
   Pub/Sub topic: statement-requests ──► statementFunction → PDF → private Cloud Storage → signed URL (10 min)
   Cloud Scheduler ──► Pub/Sub topic: scheduled-jobs ──► scheduledFunction (recurring payments daily 09:00 IST, monthly statements)
```

## 0. What you need
A Google account with a **GCP project that has billing (your student credits) attached**, and a browser. Everything is run from **Cloud Shell**
(the `>_` icon, top-right of console.cloud.google.com), so you install nothing on Windows.

## 1. One-time setup in the browser
1. **console.cloud.google.com** → create a project (e.g. `cloudbank-2535`), attach billing. Note the **Project ID**.
2. **console.firebase.google.com** → *Add project* → *choose your existing GCP project* → continue (turn Analytics off).
3. In Firebase: **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
4. In Firebase: **Project settings (gear) → General → Your apps → Web (</>) → register app "cloudbank-web"**. Copy the config values
   (`apiKey`, `authDomain`, `projectId`, `appId`). Skip the hosting checkbox.

## 2. Deploy (Cloud Shell)
Open Cloud Shell → ⋮ menu → **Upload** → choose `cloudbank.zip`. Then:
```bash
unzip cloudbank.zip && cd cloudbank
export GCP_PROJECT_ID=<your-project-id>
chmod +x scripts/*.sh
./scripts/01-setup-gcp.sh          # APIs, Firestore, Pub/Sub, bucket, BigQuery, secret, service accounts + IAM   (~3 min)
./scripts/02-deploy-backend.sh     # gcloud builds submit + gcloud run deploy                                      (~3 min)
./scripts/03-deploy-functions.sh   # 4 Cloud Functions + 2 Scheduler jobs                                          (~8 min)
cp frontend/.env.example frontend/.env && nano frontend/.env     # paste the 4 Firebase values, Ctrl+O, Enter, Ctrl+X
npx --yes firebase-tools@latest login --no-localhost            # follow the link, paste the code back
./scripts/04-deploy-frontend.sh    # builds React + deploys to Firebase Hosting + Firestore deny-all rules
```
Your app is at **https://<project-id>.web.app**.
(If `01` prints a permission or "not enabled" warning, wait 1 minute and re-run it. It is safe to repeat.)

## 3. Test it end to end (this is your demo script)
1. Open the site → **Sign up** user A, then in a private window sign up user B. Each starts with a simulated ₹10,000.
2. Copy B's **account number** (CB…). As A: **Send money** → B's number, ₹500. The balance updates instantly (**sync path**).
3. Within seconds both users see 🔔 notifications (**async path**: Pub/Sub → notifyFunction). Check B's balance and history.
4. **Idempotency (FR-04)**: in the browser DevTools → Network, right-click the `transfer` request → *Copy as cURL*, run it twice in Cloud Shell.
   Second response has `"duplicate": true` and the balance is charged once.
5. **Statements (FR-08)**: *Statements → Generate* → status goes PENDING → READY → **Download** opens the PDF via a 10-minute signed URL.
6. **Recurring (FR-07)**: *Recurring → Add* (A → B, ₹100, daily), then run the job on demand:
   `gcloud scheduler jobs run recurring-payments-daily --location asia-south1`
7. **Audit (FR-09)**: `bq query --use_legacy_sql=false 'SELECT type, COUNT(*) n, SUM(amount_paise)/100 inr FROM cloudbank_audit.transactions_audit GROUP BY type'`
8. **Admin roles and audit (FR-02/09)**: bootstrap the first administrator, then sign out/in:
   `cd backend && npm install && GCP_PROJECT_ID=$GCP_PROJECT_ID node ../scripts/set-admin.js admin@example.com && cd ..` (the user must have signed up first).
   An *Admin* tab appears with platform metrics, paginated user/role management, and a Looker Studio link once configured. Administrators can grant or remove administrator roles; users must sign out and back in before updated claims take effect. A normal user calling `/api/admin/stats` or `/api/admin/users` gets **403**.

## 4. Looker Studio dashboard (FR-09)
lookerstudio.google.com → *Create → Report → BigQuery* → project → `cloudbank_audit` → `transactions_audit` → Add.
Suggested charts: scorecard (record count), time series (`occurred_at`, metric `amount_paise`), pie (`type`), table (latest transactions). Share the report with your examiner.
Copy the report's shareable URL into `VITE_LOOKER_STUDIO_URL` in `frontend/.env`, then rebuild and redeploy the frontend (`./scripts/04-deploy-frontend.sh`). Administrators can open the report from the **Admin** tab. If this value is unset, the Admin tab explains how to configure it.

## 5. Show autoscaling (0 → N → 0)
From your laptop (PowerShell, Docker installed). Use a signed-up test user and your Firebase web **API key**:
```powershell
cd loadtest
docker run --rm -p 8089:8089 -v "${PWD}:/mnt/locust" -e API_KEY=<apiKey> -e EMAIL=<user email> -e PASSWORD=<password> locustio/locust -f /mnt/locust/locustfile.py --host https://<project-id>.web.app
```
Open http://localhost:8089 → 200 users, spawn 20/s → Start. In the console open **Cloud Run → bank-api → Metrics** → *Container instance count*:
it rises from 0/1 to several (max 10) and falls back to **0** a few minutes after you stop. Also screenshot *Request count* and *Request latencies*.
(Concurrency is set to 20 on purpose so scaling is visible.)

## 6. Security (BRD §Security / NFR) and where it lives
| Requirement | Implementation |
|---|---|
| Authentication, short-lived JWT (FR-01) | Firebase Auth; backend `verifyIdToken` on every route (`backend/src/server.js`) |
| RBAC (FR-02) | custom claim `role` = customer/admin; `requireRole('admin')` |
| ACID transfers (FR-03) | `db.runTransaction` in `shared/ledger.js` (reads first, then atomic writes) |
| No duplicate charges (FR-04) | `Idempotency-Key` header → `idempotency/{uid_key}` doc checked inside the same transaction |
| Immediate response + async fan-out (FR-05/06) | publish after commit, 3 independent subscribers |
| Private statements (FR-08) | bucket with public-access-prevention + uniform access; V4 signed URLs (10 min) |
| Least privilege | 5 dedicated service accounts, bucket/secret-level bindings (`scripts/01-setup-gcp.sh`) |
| No secrets in code | webhook URL in **Secret Manager**, injected via `--set-secrets`; Firestore has no connection string |
| Defense in depth | `firestore.rules` = deny-all for clients; helmet + HSTS headers; input validation; amount limits |
| TLS | HTTPS enforced by Hosting / Cloud Run; data encrypted at rest with Google-managed keys |

Optional live alerts: create a Discord/Slack webhook and store it:
`printf 'https://discord.com/api/webhooks/...' | gcloud secrets versions add notify-webhook-url --data-file=-` then re-run `./scripts/03-deploy-functions.sh`.

## 7. Cost (target < $1/month)
Cloud Run, Functions, Firestore, Pub/Sub, Scheduler (3 free jobs), Secret Manager and Hosting all have free tiers far above demo traffic and scale to zero.
Small items: Artifact Registry images (delete old ones: `gcloud artifacts docker images list ...`), BigQuery streaming inserts (cents), Storage (KBs).
Set a budget alert: Billing → Budgets & alerts → $5.

## 8. Troubleshooting
| Symptom | Fix |
|---|---|
| `01` errors "billing" / "permission" | Billing not attached, or APIs still enabling. Wait 1 min and re-run. |
| Login works but pages show 401 | `frontend/.env` values wrong, or you didn't rebuild: re-run `04`. |
| "Account not initialised" | The dashboard offers **Finish account setup** to safely retry the idempotent account initialization request. |
| Transactions/statements fail with "index" error | Composite index still building (`gcloud firestore indexes composite list`) or click the link in the Cloud Run log. |
| Statement stays PENDING/FAILED | `gcloud functions logs read statementFunction --gen2 --region asia-south1 --limit 30` |
| Download says signBlob/permission denied | Re-run `01` (grants `serviceAccountTokenCreator` to bank-api-sa), then re-deploy `02`. |
| Function deploy fails on Eventarc/Pub/Sub permission | Wait 2 minutes after `01`, re-run `03`. |
| No notifications | `gcloud functions logs read notifyFunction --gen2 --region asia-south1`; confirm `gcloud pubsub topics list-subscriptions transaction-completed` shows 2 subs. |

## 9. Clean up
`./scripts/teardown.sh`, or simply delete the GCP project (Console → IAM & Admin → Manage resources).

## Known limits (state these honestly in your viva)
Publishing to Pub/Sub happens after the DB commit; in a crash between the two, an event could be lost (production fix: transactional outbox).
Account numbers are looked up by query; there is no KYC or real bank rails (out of scope per BRD). Firebase Auth email/password only (no MFA in MVP).
