---
id: s_m6za
title: Grow the map from a document or a session
status: not-started
from: [n_5dqs, n_ax4k, n_2sqo]
applies_to: []
created: 2026-10-05
---
As someone using Claude Code, I want commands that turn documents and sessions into thoughts and topics,
so that what I decided elsewhere is not lost.

## Acceptance
- `/import <file>` writes one node per thought and quotes the source line in each
- `/decisions` writes the decisions of a session as decision nodes, naming the commit, and settles the thoughts they decide
- `/topics` writes three to seven topics and never changes a topic I set myself
- Changes made by a command show in the open browser without a reload
