#!/usr/bin/env bash
# Installs Argo CD Core v3.6.1 on the skopos-e2e kind cluster, for `make test-argocd`. Needs the
# network: the images, and the example repository the tests sync, come from the internet.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
config=e2e/.tmp/kubeconfig
# Tag v3.6.1. Keep it in step with the CRDs in scripts/kind-up.sh.
commit=94037c4d4e1af4bd0651d37a179fbd9e347e668c
manifest="https://raw.githubusercontent.com/argoproj/argo-cd/$commit/manifests/core-install.yaml"
kubectl --kubeconfig "$config" create namespace argocd --dry-run=client -o yaml \
  | kubectl --kubeconfig "$config" apply -f - >/dev/null
kubectl --kubeconfig "$config" --request-timeout=120s apply -n argocd --server-side \
  --force-conflicts --field-manager=skopos-e2e -f "$manifest" >/dev/null
workloads="statefulset/argocd-application-controller deployment/argocd-repo-server
  deployment/argocd-redis deployment/argocd-applicationset-controller"
# Run Argo CD on the control-plane node: the drain tests need the worker to hold only their pods.
placement='{"spec":{"template":{"spec":{
  "nodeSelector":{"kubernetes.io/hostname":"skopos-e2e-control-plane"},
  "tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'
for workload in $workloads; do
  kubectl --kubeconfig "$config" -n argocd patch "$workload" --type=merge -p "$placement" >/dev/null
done
for workload in $workloads; do
  kubectl --kubeconfig "$config" -n argocd rollout status "$workload" --timeout=600s >/dev/null
done
