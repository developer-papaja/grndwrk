---
id: s_nzdxde
title: Know who the product is for, as personas I can compare
status: done
from: [n_ps3s9e]
applies_to: ["commands/personas.md", "src/store/personas.ts", "src/store/segments.ts", "src/shared/personas.ts", "ui/index.html"]
created: 2026-11-16
---
As someone deciding what to build next, I want the people the product is for as comparable fields per segment,
so that a choice for one screen can be checked against who lives there.

## Acceptance
- [x] `/personas` writes segments and a persona per hat, with evidence lines tagged by segment and theme
- [x] The overview compares personas across segments, themes or areas, filtered by size and kind of customer
- [x] A screen's "Who it is for" holds only persona names, and new ones are made from there
- [x] What the person changed is never rewritten by the command
