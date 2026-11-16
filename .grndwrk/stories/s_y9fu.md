---
id: s_y9fu
title: Split the map into pages
status: done
from: [n_6ztc]
applies_to: ["src/shared/pages.ts", "ui/index.html"]
created: 2026-10-05
---
As someone with a large map, I want pages above topics, like in Figma,
so that different kinds of thoughts can be kept apart and the map stays maintainable.

## Acceptance
- [x] The left panel lists pages, with All first
- [x] A node is on the page named in its `page:` field, or the first page without one
- [x] The page order comes from `pages:` in `project.md`
- [x] The All page shows every node at once
