#!/usr/bin/env bash
# Builds the React app and deploys it (plus Firestore deny-all rules) to Firebase Hosting.
set -euo pipefail; source "$(dirname "$0")/config.sh"
[ -f "$ROOT/frontend/.env" ] || { echo "Create frontend/.env first (copy frontend/.env.example and fill in your Firebase web config)"; exit 1; }
( cd "$ROOT/frontend" && npm install && npm run build )
cd "$ROOT"
npx --yes firebase-tools@latest deploy --only hosting,firestore:rules --project "$PROJECT_ID"
