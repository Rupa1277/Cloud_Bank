BUSINESS REQUIREMENTS DOCUMENT
Serverless Event-Driven Digital Banking Platform

Group Members
#	Name	Seat Number
1	Riya Bandekar	25P0320032
2	Rupali Arlekar	25P0320035

 Executive Summary
Traditional banking and financial transaction backends rely heavily on fixed virtual infrastructure and monolithic software designs. These legacy systems struggle to handle sudden concurrency spikes cost-effectively, suffer from cascading failure risks when background tasks block primary user threads, and incur ongoing expenses during idle hours.
Cloud Bank is proposed as a centralized, cloud-native digital banking platform that enables users to execute secure financial transfers, check real-time balances, and manage accounts through a web-based interface. Instead of relying on always-on Virtual Machines, the platform uses a 100% serverless Google Cloud Platform (GCP) stack, separating synchronous transaction ledgers from asynchronous background processing.
An authenticated user initiates a fund transfer, and the system executes an atomic database transaction while publishing an asynchronous event to distribute background workloads such as notifications, audit logging, and statement compilation. Automatic scale-to-zero infrastructure ensures zero idle cost and strict budget compliance.
Primary objective: to demonstrate how modern serverless cloud infrastructure can deliver secure, scalable, atomic, and cost-efficient financial transaction processing for academic and practical training.
 Business Problem Statement
Current Situation
Conventional financial application prototypes and legacy systems frequently process all operations synchronously inside monolithic codebases, creating architectural bottlenecks under volatile demand.
Problems Identified
#	Problem	Description
1	Fixed Infrastructure Cost	Always-on Virtual Machines incur continuous hourly costs regardless of whether user traffic is active.
2	Synchronous Bottlenecks	Executing tasks like sending notifications or generating PDF statements inline within the core API call increases user latency and failure blast radiuses.
3	Concurrency & Race Conditions	Inadequate database locking during high-concurrency transfers leads to ledger inconsistencies or race conditions.
4	Retry Vulnerabilities	Network timeouts causing client-side request retries can result in unintended duplicate charges or double-deductions.
5	Administrative Overhead	Managing server patches, OS configurations, and manual scaling limits operational focus.
 Proposed Solution
The proposed solution is a serverless cloud banking platform that separates transaction execution into two distinct paths:
•	Synchronous Path: The core API executes an atomic, ACID-compliant balance transfer in Cloud Firestore (blocking duplicate requests via idempotency keys) and immediately publishes an event to Cloud Pub/Sub, returning a sub-second response to the user.
•	Asynchronous Path: Downstream background workers (Cloud Functions) consume the Pub/Sub event independently to handle audit logging, user notifications, and PDF statement compilation.
Deployments and infrastructure provisioning are executed via direct Google Cloud CLI controls to maintain lean, predictable release management without complex CI/CD overhead.
 Comparable and Reference Platforms Studied
As part of scoping this proposal, several cloud banking and event-driven architectures were reviewed for comparison:
•	Traditional Monolithic Banking Apps: Centralized servers handling synchronous logic. Cloud Bank borrows the decoupling of background services to eliminate blocking calls.
•	Event-Driven E-Commerce Backends: Systems using message brokers for decoupled order processing. Cloud Bank borrows the Pub/Sub asynchronous event publishing model to handle auxiliary tasks independently.
Project Objectives
#	Objective
1	Provide users with a secure, responsive digital banking interface.
2	Eliminate always-on virtual machines by implementing a 100% serverless architecture.
3	Guarantee ACID compliance and transactional atomicity for all account balance updates.
4	Prevent duplicate charges during network retries using idempotency key validation.
5	Decouple core transfer APIs from heavy background operations using Cloud Pub/Sub.
6	Scale compute resources dynamically from 0 to N instances based on live traffic.
7	Enforce strict zero-trust security via Firebase Auth, least-privilege IAM, and Secret Manager.
8	Maintain total operational expenses under $1.00/month against a $49 student credit budget.

Scope of the Project
 In-Scope
•	User Authentication: Secure sign-up, login, and token validation via Firebase Authentication and short-lived JWTs.
•	Core Ledger & Transactions: Account balance management, deposits, withdrawals, and ACID-compliant peer-to-peer transfers.
•	Asynchronous Event Bus: Event publishing via Cloud Pub/Sub (transaction.completed).
•	Background Worker Services: Independent Cloud Functions handling notifications, audit streams, and PDF statements.
•	Scheduled Operations: Cron-driven batch processing via Cloud Scheduler for recurring transfers and monthly statements.
•	Analytics & Dashboards: Centralized audit logging streamed to BigQuery and visualized via Looker Studio.
•	Deployment Model: Direct CLI-driven container builds and deployments via Cloud Build and Cloud Run.
 Out-of-Scope (Excluded from MVP)
•	Real-time ML anomaly-based fraud detection.
•	Automated CI/CD pipelines via GitHub Actions.
•	Integration with real-world banking rails (SWIFT, ACH networks).
•	Physical or virtual card issuing.
•	Multi-region cross-continent database replication.
 User Roles
•	Retail Customer: Registers/logs in, views account balances, executes peer-to-peer transfers, and downloads PDF statements.
•	System Administrator: Oversees platform telemetry, reviews audit logs via Looker Studio, and manages administrative configurations.
Functional Requirements
ID	Requirement Description
FR-01	The system shall authenticate users via Firebase Authentication and issue short-lived JWTs.
FR-02	The system shall enforce role-based access control (Retail Customer vs. Administrator) via custom JWT claims.
FR-03	The core API shall execute peer-to-peer transfers inside an ACID-compliant database transaction in Cloud Firestore.
FR-04	The transfer endpoint shall validate incoming idempotency keys to prevent duplicate charges during network retries.
FR-05	Upon successful database commit, the API shall publish a transaction.completed message to Cloud Pub/Sub and return an immediate HTTP 200 OK response.
FR-06	Downstream Cloud Functions (Notifications, Audit Logging, Statement Generation) shall consume Pub/Sub events independently and concurrently.
FR-07	Cloud Scheduler shall trigger recurring payment batch jobs by publishing scheduled payloads directly into the event bus.
FR-08	Generated PDF statements shall be stored privately in Cloud Storage and delivered to users via time-limited Signed URLs.
FR-09	Administrators shall view live reporting dashboards in Looker Studio connected directly to BigQuery audit tables.
 Non-Functional Requirements
Category	Requirement Description
Scalability	Compute services (Cloud Run API and Cloud Functions) must dynamically scale from 0 to N instances based on incoming request and event volume.
Cost Efficiency	The architecture must incur $0.00 in idle infrastructure costs when no traffic is present due to scale-to-zero serverless runtimes.
Performance	Synchronous API endpoints (balance checks, transfer initiations) must return responses within sub-second latencies under normal load.
Security	All data in transit must be encrypted via HTTPS/TLS 1.3 by default. Data at rest must be encrypted using Google-managed keys.
Access Control	The platform shall enforce the Principle of Least Privilege through isolated, component-specific IAM service accounts.
Secret Management	Hardcoded credentials and database connection strings are strictly prohibited in source code; all secrets must be fetched dynamically from Secret Manager at runtime.
Deployment Model	Builds and container deployments shall be managed via direct Google Cloud CLI commands (gcloud builds submit and gcloud run deploy).
 
 24/oct
Act as a backend developer working on this Cloud Bank repository. 

I need to showcase the platform's rule-based fraud detection feature during a live demo. Please help me create a dedicated simulation script or a new endpoint `/api/demo/simulate-fraud` in `backend/src/server.js` that triggers deterministic fraud risk signals.

Requirements for the fraud simulation:
1. Follow the fraud scoring rules defined in `shared/ledger.js`:
   - High-value transfer (>= ₹50,000): Score +60 (HIGH risk level)
   - Rapid repeated transactions: Trigger 3 consecutive outgoing transfers within 2 minutes to trigger the velocity signal (+35 points)
   - First-time recipient in history window: (+10 points)
2. Ensure the transfers execute inside the existing atomic Firestore transaction (`db.runTransaction`) using standard integer paise for amounts.
3. Keep the transfer execution non-blocking (do NOT reject or block valid transfers when high risk is calculated; retain normal success status and include the `risk` object in the response).
4. Persist the generated `risk_score`, `risk_level`, and `risk_reasons` to Firestore and publish the event to Pub/Sub topic `transaction-completed` so `auditFunction` streams it to BigQuery.
5. Include inline code comments explaining how each rule is triggered so I can explain it during my presentation.

Please generate the required backend handler code in `backend/src/server.js` and a helper script in `loadtest/simulate-fraud.js` that calls this endpoint.