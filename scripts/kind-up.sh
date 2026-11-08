#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p e2e/.tmp
config=e2e/.tmp/kubeconfig

create_cluster() {
  # kind merges into an existing file, and the tests expect this cluster alone in it.
  rm -f "$config"
  kind create cluster --name skopos-e2e --config e2e/fixtures/kind-config.yaml \
    --kubeconfig "$config" --wait 120s
}

# Without -q, grep reads everything, so `kind` cannot die of SIGPIPE under pipefail.
if ! kind get clusters 2>/dev/null | grep -x skopos-e2e >/dev/null; then
  create_cluster
elif [ "$(kind get nodes --name skopos-e2e | wc -l)" -lt 2 ]; then
  # Made before the drain tests needed a worker. This cluster exists only for tests.
  kind delete cluster --name skopos-e2e
  create_cluster
else
  for node in $(kind get nodes --name skopos-e2e); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$node")" != "true" ]; then
      docker start "$node" >/dev/null
    fi
  done
  kind get kubeconfig --name skopos-e2e > "$config"
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
kubectl --kubeconfig "$config" --request-timeout=30s uncordon skopos-e2e-worker >/dev/null
# The Argo CD Application and AppProject CRDs, for the tests that write Applications. The
# commit is tag v3.6.1; keep it in step with scripts/argocd-up.sh.
crds=https://raw.githubusercontent.com/argoproj/argo-cd/94037c4d4e1af4bd0651d37a179fbd9e347e668c/manifests/crds
kubectl --kubeconfig "$config" --request-timeout=60s apply --server-side --force-conflicts \
  --field-manager=skopos-e2e -f "$crds/application-crd.yaml" -f "$crds/appproject-crd.yaml" >/dev/null
# A CRD just created has no status.conditions yet, and kubectl wait then fails at once instead
# of waiting (seen on CI), so try again before the last, loud attempt.
for _ in $(seq 1 30); do
  kubectl --kubeconfig "$config" wait --for=condition=Established --timeout=60s \
    crd/applications.argoproj.io crd/appprojects.argoproj.io >/dev/null 2>&1 && break
  sleep 2
done
kubectl --kubeconfig "$config" wait --for=condition=Established --timeout=60s \
  crd/applications.argoproj.io crd/appprojects.argoproj.io >/dev/null
