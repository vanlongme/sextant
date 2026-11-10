#!/usr/bin/env bash
# Removes what `make test-metrics` installed, so it leaves the shared skopos-e2e cluster as it
# found it: the Prometheus release with its namespace and cluster-wide RBAC, the test
# namespaces, and metrics-server.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
config=e2e/.tmp/kubeconfig
manifest=https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.1/components.yaml
kubectl --kubeconfig "$config" delete namespace skopos-metrics skopos-metrics-query \
  skopos-metrics-usage --ignore-not-found --wait=true --timeout=300s >/dev/null
kubectl --kubeconfig "$config" delete clusterrole,clusterrolebinding \
  -l app.kubernetes.io/instance=skopos-prometheus --ignore-not-found >/dev/null
kubectl --kubeconfig "$config" --request-timeout=120s delete --ignore-not-found \
  -f "$manifest" >/dev/null
