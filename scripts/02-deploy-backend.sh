#!/usr/bin/env bash
# Build image with Cloud Build, deploy to Cloud Run (scale 0..10). BRD: gcloud builds submit + gcloud run deploy.
set -euo pipefail; source "$(dirname "$0")/config.sh"
cp "$ROOT/shared/ledger.js" "$ROOT/backend/src/ledger.js"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/bank-api:$(date +%Y%m%d-%H%M%S)"
gcloud builds submit "$ROOT/backend" --tag "$IMAGE" --project "$PROJECT_ID"
gcloud run deploy bank-api --image "$IMAGE" --region "$REGION" --platform managed \
  --service-account "$(sa bank-api-sa)" --allow-unauthenticated \
  --min-instances 0 --max-instances 10 --concurrency 20 --memory 512Mi --cpu 1 --timeout 30 \
  --set-env-vars "STATEMENT_BUCKET=$BUCKET,TOPIC_TX=transaction-completed,TOPIC_STMT=statement-requests"
gcloud run services describe bank-api --region "$REGION" --format='value(status.url)'
# --allow-unauthenticated = the URL is public, but EVERY /api route (except /health) rejects requests without a valid Firebase JWT.
# --concurrency 20 is deliberately low so Cloud Run visibly adds instances during the demo load test.
