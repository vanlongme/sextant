#!/usr/bin/env bash
# Installs metrics-server v0.9.1 on the skopos-e2e kind cluster, for `make test-metrics`. Needs
# the network. The Prometheus chart is installed by the tests, with the app's own Helm code.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
config=e2e/.tmp/kubeconfig
manifest=https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.1/components.yaml
kubectl --kubeconfig "$config" --request-timeout=120s apply -f "$manifest" >/dev/null
# kind's kubelets serve self-signed certificates. A new apply drops the flag, so check each time.
args=$(kubectl --kubeconfig "$config" -n kube-system get deployment metrics-server \
  -o jsonpath='{.spec.template.spec.containers[0].args}')
if [[ "$args" != *--kubelet-insecure-tls* ]]; then
  kubectl --kubeconfig "$config" -n kube-system patch deployment metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
    >/dev/null
fi
# Run it on the control-plane node, as Argo CD does: the drain tests need the worker to hold
# only their pods.
placement='{"spec":{"template":{"spec":{
  "nodeSelector":{"kubernetes.io/hostname":"skopos-e2e-control-plane"},
  "tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]}}}}'
kubectl --kubeconfig "$config" -n kube-system patch deployment metrics-server --type=merge \
  -p "$placement" >/dev/null
kubectl --kubeconfig "$config" -n kube-system rollout status deployment/metrics-server \
  --timeout=300s >/dev/null
kubectl --kubeconfig "$config" wait --for=condition=Available \
  apiservice/v1beta1.metrics.k8s.io --timeout=300s >/dev/null
