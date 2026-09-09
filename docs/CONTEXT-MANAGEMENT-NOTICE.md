# Remote Context attribution

The protocol and behavior in `src/context-management/` are adapted from:

- `awoaCrim/pi-openai-toolkit`, commit `1d3972c7ae64397463e922d8fe8333279df352d8`,
  `src/context-management/` and related lifecycle/header code.
- That project's NOTICE identifies its Remote Context upstream as
  `@howaboua/pi-codex-conversion@3.0.29`, source commit
  `7021ae48e8efe36a3becc5830d529696ff798e5e`.

This adaptation changes provider selection, lifecycle integration, configuration,
checkpoint enforcement and local-history retention for pi-openai-server-compaction.
It does not include the toolkit's Web Search, Astra planner or image features.

## Upstream MIT copyright and permission notices

Copyright (c) 2026 lll9p

Copyright (c) 2026 awoaCrim and contributors

Copyright (c) 2026 Igor Warzocha

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
