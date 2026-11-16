---
id: s_q7m2
title: Capture a thought in one line
status: done
from: [n_46od, n_3cgp, n_7hoj, n_so17]
applies_to: ["ui/src/capture.ts", "ui/src/state.ts"]
created: 2026-10-05
---
As someone exploring a product idea, I want to type a line and press Enter to add a thought,
so that capture never slows my thinking down.

## Acceptance
- [x] Typing a title in the bottom bar and pressing Enter writes a new node file with only a title required
- [x] `?` makes a question and `!` makes a decision, with or without a space after
- [x] The new card lights up for a few seconds and a note says where it went
- [x] Adding a title that already exists adds nothing and points at the existing card
