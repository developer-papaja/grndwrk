---
id: s_snvinz
title: Test what the agent built, step by step, and approve or send it back
status: done
from: [n_99xafl, n_8bdpka, n_h7gy7m, n_tkm3qn]
applies_to: ["src/shared/feedback.ts", "src/shared/progress.ts", "ui/index.html", "overlay/feedback.js", "clients/ios/GrndwrkFeedback/Sources/GrndwrkFeedback/CommentsList.swift", "templates/CLAUDE.md"]
created: 2026-11-16
---
As the person who asked for a change, I want to go through the agent's steps to test it,
so that nothing is called done before I have seen it work.

## Acceptance
- [x] A thought or comment the agent built shows as Ready to test, with what changed and numbered steps
- [x] Each step has Works and No, and a step marked No takes a note and pictures
- [x] Works marks it done; Doesn't work sends it back with what is still wrong, quoted
- [x] The phone and the web button test fixes on the page or screen they were made on
- [x] The agent never settles what it built unless asked
