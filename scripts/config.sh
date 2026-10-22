#!/usr/bin/env bash
# Shared settings. Usage: export GCP_PROJECT_ID=your-project-id  (then run the numbered scripts)
export PROJECT_ID="${GCP_PROJECT_ID:?Run: export GCP_PROJECT_ID=your-project-id}"
export REGION="${REGION:-asia-south1}"
export BUCKET="${PROJECT_ID}-statements"
export REPO="bank-repo"
export DATASET="cloudbank_audit"
export ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sa() { echo "$1@${PROJECT_ID}.iam.gserviceaccount.com"; }
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
