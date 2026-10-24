#!/usr/bin/env bash
# Creates every GCP resource: APIs, Firestore, Pub/Sub, Storage, BigQuery, Secret, service accounts + least-privilege IAM.
set -euo pipefail; source "$(dirname "$0")/config.sh"
gcloud config set project "$PROJECT_ID"
echo "== Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com cloudfunctions.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com bigquery.googleapis.com \
  storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com eventarc.googleapis.com identitytoolkit.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com cloudresourcemanager.googleapis.com logging.googleapis.com
echo "== Firestore (Native mode, $REGION)"
gcloud firestore databases create --location="$REGION" --type=firestore-native 2>/dev/null || echo "   (already exists)"
gcloud firestore indexes composite create --collection-group=transactions --query-scope=COLLECTION \
  --field-config=field-path=participants,array-config=contains --field-config=field-path=createdAt,order=descending 2>/dev/null || echo "   (index exists)"
echo "== Artifact Registry"
gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" 2>/dev/null || echo "   (exists)"
echo "== Pub/Sub topics"
for t in transaction-completed statement-requests scheduled-jobs; do gcloud pubsub topics create "$t" 2>/dev/null || echo "   ($t exists)"; done
echo "== Cloud Storage (private statements bucket)"
gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention 2>/dev/null || echo "   (exists)"
echo "== BigQuery audit dataset + table"
bq --location="$REGION" mk -d "$PROJECT_ID:$DATASET" 2>/dev/null || echo "   (dataset exists)"
bq mk -t "$PROJECT_ID:$DATASET.transactions_audit" "$ROOT/scripts/audit_schema.json" 2>/dev/null || echo "   (table exists)"
bq update --schema "$ROOT/scripts/audit_schema.json" "$PROJECT_ID:$DATASET.transactions_audit"
echo "== Secret Manager (notification webhook; replace the placeholder later if you want live alerts)"
printf 'none' | gcloud secrets create notify-webhook-url --data-file=- --replication-policy=automatic 2>/dev/null || echo "   (secret exists)"
echo "== Service accounts (one per component = least privilege)"
for s in bank-api-sa bank-notify-sa bank-audit-sa bank-statement-sa bank-batch-sa; do
  gcloud iam service-accounts create "$s" --display-name="Cloud Bank $s" 2>/dev/null || echo "   ($s exists)"; done
sleep 8
add() { gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$(sa $1)" --role="$2" --condition=None --quiet >/dev/null; echo "   $1 -> $2"; }
add bank-api-sa roles/datastore.user;        add bank-api-sa roles/pubsub.publisher;  add bank-api-sa roles/firebaseauth.admin
add bank-notify-sa roles/datastore.user
add bank-statement-sa roles/datastore.user
add bank-batch-sa roles/datastore.user;      add bank-batch-sa roles/pubsub.publisher
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$(sa bank-api-sa)" --role=roles/storage.objectViewer --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$(sa bank-statement-sa)" --role=roles/storage.objectCreator --quiet >/dev/null
# API signs download URLs as itself (v4 signed URLs on Cloud Run need signBlob permission on its own identity)
gcloud iam service-accounts add-iam-policy-binding "$(sa bank-api-sa)" --member="serviceAccount:$(sa bank-api-sa)" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null
gcloud secrets add-iam-policy-binding notify-webhook-url --member="serviceAccount:$(sa bank-notify-sa)" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
bq add-iam-policy-binding --member="serviceAccount:$(sa bank-audit-sa)" --role=roles/bigquery.dataEditor "$PROJECT_ID:$DATASET.transactions_audit" >/dev/null 2>&1 \
  || add bank-audit-sa roles/bigquery.dataEditor
echo "== Build/deploy permissions for the default compute service account"
CS="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for r in roles/cloudbuild.builds.builder roles/eventarc.eventReceiver roles/run.invoker roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$CS" --role="$r" --condition=None --quiet >/dev/null; done
echo "DONE. Next: ./scripts/02-deploy-backend.sh"
