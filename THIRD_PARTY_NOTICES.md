# Third-party notices

SkoposIDE is new code, written for this project. Parts of its logic are adapted from the
open-source projects below, whose license requires this notice to stay with the code.
Libraries that SkoposIDE depends on carry their own licenses in `Cargo.lock` and
`pnpm-lock.yaml`.

## Freelens

- Source: https://github.com/freelensapp/freelens
- Reference commit: `3f2b73426bab36e68c31bb2c403e815187148ad7`
- License: MIT

```text
MIT License

Copyright (c) 2024-2026 Freelens Authors.

Copyright (c) 2022 OpenLens Authors.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Kubernetes

Status strings and the drain behaviour follow `kubectl`, part of the Kubernetes project
(https://github.com/kubernetes/kubernetes and https://github.com/kubernetes/kubectl).
Copyright The Kubernetes Authors. Licensed under Apache-2.0, the license in `LICENSE`.

## Reading the reference locally

Reference code is not part of this repository. Clone it into `tmp/reference/`, which git
ignores, at the commit above. Delete its agent instruction files, so tools do not load them
as instructions for this project:

```sh
git init tmp/reference/freelens
cd tmp/reference/freelens
git fetch --depth 1 https://github.com/freelensapp/freelens 3f2b73426bab36e68c31bb2c403e815187148ad7
git checkout FETCH_HEAD
rm -rf .claude AGENTS.md CLAUDE.md
```

Read this code only. Do not install, build or run it.
