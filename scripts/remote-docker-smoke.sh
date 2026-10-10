#!/usr/bin/env bash
# Run the CI guide's "Docker on another host" block from a job container against a docker-in-docker host with TLS.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${1:?Usage: scripts/remote-docker-smoke.sh <image>}"
dind="docker:29.9.0-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470"
cli="docker:29.9.0-cli@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00"
node="node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1"
id="admin-sdk-mock-remote-$$"
work="$(mktemp -d)"
inner() { docker exec -i "$id" docker -H unix:///var/run/docker.sock "$@"; }
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "remote docker smoke failed (exit $rc). Mock log:"
    inner logs admin-sdk-mock 2>&1 || true
  fi
  # -v removes the anonymous /var/lib/docker volume that holds the loaded image.
  docker rm -f -v "$id" > /dev/null 2>&1 || true
  docker network rm "$id" > /dev/null 2>&1 || true
  docker volume rm "$id-certs" > /dev/null 2>&1 || true
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
# The guide's block, with the image that the docker-in-docker host holds.
awk '/^### Docker on another host$/ { section = 1 } section && /^```sh$/ { block = 1; next } block && /^```$/ { exit } block' docs/guide/ci.md \
  | sed 's#ghcr\.io/campuscommander/admin-sdk-mock:[^[:space:]]*#admin-sdk-mock:remote#' > "$work/recipe.sh"
for part in 'admin-sdk-mock:remote' 'docker cp ' 'docker start ' 'NO_PROXY=.*,docker '; do
  grep -q "$part" "$work/recipe.sh" \
    || { echo "The Docker on another host block in docs/guide/ci.md lacks '$part'."; exit 1; }
done
# The example configuration writes its key file to /out/credentials/ci.json, the path that the block copies.
cp examples/github-actions/admin-sdk-mock.json "$work/admin-sdk-mock.json"
cat > "$work/job.sh" << 'EOF'
set -euo pipefail
. ./recipe.sh
customer="$(docker exec admin-sdk-mock cat /out/ready.json | grep -m 1 -o '"customerId": *"[^"]*"' | cut -d '"' -f 4)"
# A docker command after the exports proves that NO_PROXY keeps the Docker CLI off the proxy.
docker exec admin-sdk-mock admin-sdk-mock token "$customer" --scopes read --raw > token
test -s ci.json || { echo "The key file was not copied."; exit 1; }
EOF
docker network create "$id" > /dev/null
docker volume create "$id-certs" > /dev/null
docker run --detach --privileged --name "$id" --network "$id" --network-alias docker \
  -e DOCKER_TLS_CERTDIR=/certs -v "$id-certs:/certs" "$dind" > /dev/null
for _ in $(seq 1 60); do
  inner version > /dev/null 2>&1 && break
  sleep 1
done
inner version > /dev/null || { echo "The docker-in-docker host did not start."; docker logs "$id"; exit 1; }
docker save "$image" | inner load > /dev/null
inner tag "$image" admin-sdk-mock:remote
docker run --rm --network "$id" -w /job -v "$work:/job" -v "$id-certs:/certs:ro" \
  -e DOCKER_HOST=tcp://docker:2376 -e DOCKER_TLS_VERIFY=1 -e DOCKER_CERT_PATH=/certs/client \
  "$cli" sh job.sh
docker run --rm --network "$id" -v "$work:/job:ro" \
  -e HTTPS_PROXY=http://docker:13128 -e NODE_USE_ENV_PROXY=1 -e NODE_EXTRA_CA_CERTS=/job/mock-ca.pem \
  "$node" node -e '
const token = require("node:fs").readFileSync("/job/token", "utf8").trim();
const url = "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=1";
const main = async () => {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.text();
  if (response.status !== 200 || !body.includes("primaryEmail")) throw new Error(`users.list answered ${response.status}: ${body}`);
  const tunneled = await fetch("https://example.com/").then(() => true, () => false);
  if (tunneled) throw new Error("The proxy tunneled a non-Google target with passthrough off.");
};
main().catch((error) => { console.error(error.message); process.exit(1); });
'
echo "remote docker smoke passed (TLS docker-in-docker: ready, key file copied, docker CLI after the exports, users.list 200 through docker:13128, non-Google target refused)"
