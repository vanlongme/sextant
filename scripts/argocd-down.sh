#!/usr/bin/env bash
# Removes what scripts/argocd-up.sh installed, so `make test-argocd` leaves the shared skopos-e2e
# cluster as it found it. The Application and AppProject CRDs stay: scripts/kind-up.sh owns them.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
config=e2e/.tmp/kubeconfig
# With the controller going too, an Application left with its finalizer would hold the namespace.
for app in $(kubectl --kubeconfig "$config" -n argocd get applications.argoproj.io -o name 2>/dev/null); do
  kubectl --kubeconfig "$config" -n argocd patch "$app" --type=merge \
    -p '{"metadata":{"finalizers":null}}' >/dev/null
done
kubectl --kubeconfig "$config" delete namespace argocd --ignore-not-found --wait=true \
  --timeout=300s >/dev/null
kubectl --kubeconfig "$config" delete --ignore-not-found clusterrole/argocd-application-controller \
  clusterrolebinding/argocd-application-controller crd/applicationsets.argoproj.io >/dev/null
