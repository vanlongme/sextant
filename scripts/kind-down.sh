#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# --kubeconfig keeps kind away from the default kubeconfig when it removes the context.
kind delete cluster --name skopos-e2e --kubeconfig e2e/.tmp/kubeconfig
