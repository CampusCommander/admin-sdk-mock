#!/usr/bin/env bash
# Usage: list-users.sh <customerId>
# Needs the mock client environment (HTTPS_PROXY, NODE_EXTRA_CA_CERTS) and admin-sdk-mock on PATH.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: list-users.sh <customerId>" >&2
  exit 2
fi

token="$(admin-sdk-mock token "$1" --scopes read --raw)"

curl --fail-with-body --silent --show-error \
  --proxy "$HTTPS_PROXY" --cacert "$NODE_EXTRA_CA_CERTS" \
  --header "Authorization: Bearer $token" \
  "https://admin.googleapis.com/admin/directory/v1/users?customer=$1&maxResults=5"
