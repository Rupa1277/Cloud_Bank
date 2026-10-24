#!/usr/bin/env bash
# Deploys 4 Pub/Sub-triggered Cloud Functions (gen2) + 2 Cloud Scheduler jobs.
set -euo pipefail; source "$(dirname "$0")/config.sh"
cp "$ROOT/shared/ledger.js" "$ROOT/functions/ledger.js"
ENVV="STATEMENT_BUCKET=$BUCKET,BQ_DATASET=$DATASET,TOPIC_TX=transaction-completed,TOPIC_STMT=statement-requests"
deploy() { # name topic service-account [extra flags]
  local name=$1 topic=$2 acct=$3; shift 3
  gcloud functions deploy "$name" --gen2 --runtime nodejs22 --region "$REGION" --source "$ROOT/functions" \
    --entry-point "$name" --trigger-topic "$topic" --service-account "$(sa "$acct")" \
    --memory 256Mi --timeout 120s --min-instances 0 --max-instances 5 --set-env-vars "$ENVV" "$@"
}
deploy notifyFunction    transaction-completed bank-notify-sa    --set-secrets "NOTIFY_WEBHOOK_URL=notify-webhook-url:latest"
deploy auditFunction     transaction-completed bank-audit-sa
deploy statementFunction statement-requests    bank-statement-sa --memory 512Mi
deploy scheduledFunction scheduled-jobs        bank-batch-sa
echo "== Cloud Scheduler (publishes straight into Pub/Sub: FR-07)"
mk() { gcloud scheduler jobs create pubsub "$1" --location "$REGION" --schedule "$2" --time-zone "Asia/Kolkata" --topic scheduled-jobs --message-body "$3" 2>/dev/null \
  || gcloud scheduler jobs update pubsub "$1" --location "$REGION" --schedule "$2" --time-zone "Asia/Kolkata" --topic scheduled-jobs --message-body "$3"; }
mk recurring-payments-daily "0 9 * * *"  '{"job":"recurring-payments"}'
mk monthly-statements       "0 2 1 * *"  '{"job":"monthly-statements"}'
echo "DONE. Trigger a job manually any time:  gcloud scheduler jobs run recurring-payments-daily --location $REGION"
