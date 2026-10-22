#!/usr/bin/env bash
# Removes billable/demo resources. Safest alternative: delete the whole GCP project in the console.
set -uo pipefail; source "$(dirname "$0")/config.sh"
gcloud scheduler jobs delete recurring-payments-daily monthly-statements --location "$REGION" --quiet
for f in notifyFunction auditFunction statementFunction scheduledFunction; do gcloud functions delete $f --gen2 --region "$REGION" --quiet; done
gcloud run services delete bank-api --region "$REGION" --quiet
gcloud pubsub topics delete transaction-completed statement-requests scheduled-jobs --quiet
gcloud storage rm -r "gs://$BUCKET" --quiet
bq rm -r -f -d "$PROJECT_ID:$DATASET"
gcloud artifacts repositories delete "$REPO" --location "$REGION" --quiet
