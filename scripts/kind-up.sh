#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/.tmp
# Without -q, grep reads everything, so `kind` cannot die of SIGPIPE under pipefail.
if ! kind get clusters 2>/dev/null | grep -x sextant-e2e >/dev/null; then
  kind create cluster --name sextant-e2e --kubeconfig e2e/.tmp/kubeconfig --wait 120s
else
  if [ "$(docker inspect -f '{{.State.Running}}' sextant-e2e-control-plane)" != "true" ]; then
    docker start sextant-e2e-control-plane >/dev/null
  fi
  kind get kubeconfig --name sextant-e2e > e2e/.tmp/kubeconfig
fi
# A restarted container's API server takes a while to answer.
for _ in $(seq 1 60); do
  if kubectl --kubeconfig e2e/.tmp/kubeconfig --request-timeout=5s get nodes >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done
kubectl --kubeconfig e2e/.tmp/kubeconfig --request-timeout=5s get nodes >/dev/null
