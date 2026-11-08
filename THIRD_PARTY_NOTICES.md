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

## Argo CD

- Source: https://github.com/argoproj/argo-cd
- Reference tag: `v3.6.1`, commit `94037c4d4e1af4bd0651d37a179fbd9e347e668c`
- License: Apache-2.0, the license in `LICENSE`. Copyright 2017-2018 The Argo Authors. The
  project has no NOTICE file.

The Argo CD actions write an Application the way the Argo CD API server does
(`server/application/application.go` and `util/argo/argo.go`). The tests install its CRDs and
`manifests/core-install.yaml` from that commit.

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

Argo CD is cloned the same way, sparse, with only the parts this project reads:

```sh
git init tmp/reference/argo-cd
cd tmp/reference/argo-cd
git fetch --depth 1 --filter=blob:none https://github.com/argoproj/argo-cd 94037c4d4e1af4bd0651d37a179fbd9e347e668c
git sparse-checkout set --no-cone /LICENSE /server/application/ /util/argo/ \
  /pkg/apis/application/v1alpha1/ /manifests/core-install.yaml /manifests/crds/ /docs/user-guide/ \
  /docs/operator-manual/core.md /docs/operator-manual/declarative-setup.md \
  /controller/appcontroller.go /controller/sync.go /common/common.go
git checkout FETCH_HEAD
rm -rf .claude AGENTS.md CLAUDE.md
```

Read this code only. Do not install, build or run it.

## Fonts

SkoposIDE bundles these fonts, unmodified, from their Fontsource packages. Both are under
the SIL Open Font License 1.1, whose text follows.

- **Manrope** (`@fontsource/manrope` 5.3): Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)
- **JetBrains Mono** (`@fontsource/jetbrains-mono` 5.3): Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

```text
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
