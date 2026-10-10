#!/usr/bin/env bash
# Start the image from a mounted configuration and call the Directory API through its proxy.
set -euo pipefail
image="${1:?Usage: scripts/image-smoke.sh <image>}"
work="$(mktemp -d)"
name="admin-sdk-mock-smoke-$$"
cleanup() {
  docker logs "$name" > "$work/container.log" 2>&1 || true
  docker rm -f "$name" > /dev/null 2>&1 || true
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
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    docker logs "$name"
    exit 1
  fi
  sleep 1
done
[ -f "$work/out/ready.json" ] || { echo "The mock did not become ready."; docker logs "$name"; exit 1; }
customer="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$work/out/ready.json','utf8')).domains[0].customerId)")"
token="$(docker exec "$name" admin-sdk-mock token "$customer" --scopes read --raw)"
status="$(curl --silent --output "$work/users.json" --write-out '%{http_code}' \
  --proxy http://127.0.0.1:13129 --cacert "$work/out/ca.pem" \
  -H "Authorization: Bearer $token" \
  "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer")"
[ "$status" = "200" ] || { echo "users.list answered $status"; cat "$work/users.json"; exit 1; }
grep -q '"primaryEmail"' "$work/users.json"
refused="$(curl --silent --output /dev/null --write-out '%{http_code}' --proxy http://127.0.0.1:13129 https://example.com/ || true)"
[ -f "$work/out/credentials/smoke.json" ] || { echo "The key file is missing."; exit 1; }
echo "image smoke passed (users.list 200, key file written, non-Google CONNECT gave ${refused})"
