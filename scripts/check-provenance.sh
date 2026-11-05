#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pattern="$(printf '%s' 'XGJsZW5zXGJ8azhzbGVuc3xtaXJhbnRpc3xvcGVubGVuc3xmcmVlbGVuc3xsZW5zYXBwfGxlbnMtZGVza3RvcHxvZ3JlLXRvb2xzfGt1YmUtYXV0aC1wcm94eQ==' | base64 -d)"
matches="$(git ls-files -z --cached --others --exclude-standard -- ':!:pnpm-lock.yaml' ':!:Cargo.lock' | xargs -0 -r grep -s -I -n -i -E "$pattern" || true)"
if [ -n "$matches" ]; then
  printf '%s\n' "$matches"
  echo "provenance check failed: forbidden token in the files above" >&2
  exit 1
fi
