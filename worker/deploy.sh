#!/bin/bash
# Deploys worker.js to Cloudflare. Must always include ALL non-secret bindings
# (KV namespaces, plain_text vars) in metadata.json, or they get silently wiped
# on deploy (secrets survive automatically, plain vars/KV do not).
set -euo pipefail
cd "$(dirname "$0")"
set -a; source /Users/leosantana/.config/cloudflare/token.env; set +a
ACCOUNT_ID=e5fb63286d36e63687bf9109759eb70e
SCRIPT_NAME=newbreak-costs-api
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -F "metadata=@metadata.json;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module"
echo
