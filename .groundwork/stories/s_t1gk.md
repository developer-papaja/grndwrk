---
id: s_t1gk
title: Know whether I am ready to build
status: not-started
from: [n_0pvl, n_dtmw, n_scwj]
applies_to: []
created: 2026-10-05
---
As someone kicking off a product, I want a clear verdict and the gaps that stand in the way,
so that I know what to add before I start building.

## Acceptance
- `/readiness` writes `report.md` with a verdict of ready to build, ready to prototype or not ready
- Each gap shows as a ghost card near the thoughts it relates to, with why it matters
- Answering a ghost card turns it into a real node, and the next `/readiness` drops the gap when the answer closes it
- The readiness checks include setup for building with Claude: CLAUDE.md, design docs and references, code standards, skills
- It is clear at a glance which gaps are answered and which are not
