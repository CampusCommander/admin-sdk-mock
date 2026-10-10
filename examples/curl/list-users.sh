#!/usr/bin/env bash
# Usage: list-users.sh <customerId>
# Needs the mock client environment (HTTPS_PROXY, NODE_EXTRA_CA_CERTS).
# ADMIN_SDK_MOCK names the CLI command. It defaults to admin-sdk-mock on PATH.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: list-users.sh <customerId>" >&2
  exit 2
fi

# The variable is unquoted on purpose, so a command such as "node dist/bin/admin-sdk-mock.js" splits into words.
# shellcheck disable=SC2086
token="$(${ADMIN_SDK_MOCK:-admin-sdk-mock} token "$1" --scopes read --raw)"

curl --fail-with-body --silent --show-error --max-time 30 \
  --proxy "$HTTPS_PROXY" --cacert "$NODE_EXTRA_CA_CERTS" \
  --header "Authorization: Bearer $token" \
  "https://admin.googleapis.com/admin/directory/v1/users?customer=$1&maxResults=5"
