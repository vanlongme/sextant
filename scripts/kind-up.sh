#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/.tmp
config=e2e/.tmp/kubeconfig

create_cluster() {
  kind create cluster --name sextant-e2e --config e2e/fixtures/kind-config.yaml \
    --kubeconfig "$config" --wait 120s
}

# Without -q, grep reads everything, so `kind` cannot die of SIGPIPE under pipefail.
if ! kind get clusters 2>/dev/null | grep -x sextant-e2e >/dev/null; then
  create_cluster
elif [ "$(kind get nodes --name sextant-e2e | wc -l)" -lt 2 ]; then
  # Made before the drain tests needed a worker. This cluster exists only for tests.
  kind delete cluster --name sextant-e2e
  create_cluster
else
  for node in $(kind get nodes --name sextant-e2e); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$node")" != "true" ]; then
      docker start "$node" >/dev/null
    fi
  done
  kind get kubeconfig --name sextant-e2e > "$config"
fi
# A restarted container's API server takes a while to answer.
for _ in $(seq 1 60); do
  if kubectl --kubeconfig "$config" --request-timeout=5s get nodes >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
kubectl --kubeconfig "$config" --request-timeout=5s get nodes >/dev/null
# A run that died in the middle of a drain must not break the next one.
kubectl --kubeconfig "$config" --request-timeout=30s uncordon sextant-e2e-worker >/dev/null
