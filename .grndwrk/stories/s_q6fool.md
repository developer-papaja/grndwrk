---
id: s_q6fool
title: Go through the questions I cannot answer with the person who can
status: done
from: [n_rsi4qt, n_c5mfm0, n_a81jyk, n_mrf9kl]
applies_to: ["src/store/waiting.ts", "src/shared/thread.ts", "commands/questions.md", "ui/index.html"]
created: 2026-11-16
---
As someone the agent asks questions, I want to mark the ones another person must answer,
so that I can sit down with them and go through only theirs.

## Acceptance
- [x] Every question the agent asks ends up in the map, also from a chat (`/questions`)
- [x] Several options can be picked in one answer, and an answer given too quickly can be undone or changed
- [x] A question can wait for a named person, or for an answer, and the Inbox filters by it
- [x] Names stay off the map unless project.md says `personal_info: yes`
