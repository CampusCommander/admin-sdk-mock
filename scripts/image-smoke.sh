#!/usr/bin/env bash
# Start the image from a mounted configuration and call the Directory API through its proxy.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${1:?Usage: scripts/image-smoke.sh <image>}"
work="$(mktemp -d)"
name="admin-sdk-mock-smoke-$$"
cleanup() {
  rc=$?
  docker logs "$name" > "$work/container.log" 2>&1 || true
  if [ "$rc" -ne 0 ]; then
    echo "image smoke failed (exit $rc). Container log:"
    cat "$work/container.log" || true
  fi
  docker rm -f "$name" > /dev/null 2>&1 || true
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
mkdir -p "$work/data" "$work/out"
docker run --detach --name "$name" \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:18081:8080 -p 127.0.0.1:13129:3128 \
  -v "$work/data:/data" -v "$work/out:/out" \
  -v "$(pwd)/scripts/smoke-config.json:/config/admin-sdk-mock.json:ro" \
  -e MOCK_GOOGLE_PORT=8443 -e MOCK_PROXY_PORT=3128 \
  -e MOCK_CA_EXPORT=/out/ca.pem -e MOCK_READY_FILE=/out/ready.json \
  "$image" > /dev/null
for _ in $(seq 1 120); do
  [ -f "$work/out/ready.json" ] && break
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2> /dev/null || echo false)" != "true" ]; then
    echo "The container stopped before the mock became ready."
    exit 1
  fi
  sleep 1
done
[ -f "$work/out/ready.json" ] || { echo "The mock did not become ready."; exit 1; }
customer="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).domains[0].customerId)" "$work/out/ready.json")" \
  || { echo "The ready file has no domains[0].customerId."; exit 1; }
token="$(docker exec "$name" admin-sdk-mock token "$customer" --scopes read --raw)" \
  || { echo "admin-sdk-mock token failed"; exit 1; }
curl_rc=0
status="$(curl --silent --output "$work/users.json" --write-out '%{http_code}' \
  --proxy http://127.0.0.1:13129 --cacert "$work/out/ca.pem" \
  -H "Authorization: Bearer $token" \
  "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer")" || curl_rc=$?
if [ "$status" != "200" ]; then
  echo "users.list answered $status (curl exit $curl_rc)"
  cat "$work/users.json" 2> /dev/null || true
  exit 1
fi
grep -q '"primaryEmail"' "$work/users.json" \
  || { echo "users.list response has no primaryEmail"; cat "$work/users.json"; exit 1; }
# %{http_connect} holds the proxy's answer to CONNECT. %{http_code} stays 000 when the tunnel fails.
refused="$(curl --silent --output /dev/null --write-out '%{http_connect}' --proxy http://127.0.0.1:13129 https://example.com/ || true)"
[ "$refused" = "403" ] || { echo "The proxy answered ${refused} to a non-Google CONNECT, not 403."; exit 1; }
[ -f "$work/out/credentials/smoke.json" ] || { echo "The key file is missing."; exit 1; }
echo "image smoke passed (users.list 200, key file written, non-Google CONNECT refused with 403)"
