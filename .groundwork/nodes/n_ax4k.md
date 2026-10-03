---
id: n_ax4k
type: question
title: Would it be possible to also sync all the decisions taken in claude with a command here?
topic: working with claude
topic_by: claude
page: Product
altitude: 3
links: [n_scwj]
status: settled
created: 2026-10-03
---
Answer from Claude:

Yes. A /decisions command you run at the end of a Claude Code session: it looks back over the conversation (and recent commits) and writes each decision made as a decision node, linked to the thoughts it settles, and marks those settled. That is what Claude has been doing by hand in this map.

Done in 37113ff: /decisions writes the decisions of a session into the map, naming the commit.

## Thread

**Claude asks** · 2026-10-03
Should .groundwork/ be committed to git? Then the history of the map, and of every decision written into it, is kept with the code.

**You** · 2026-10-03
Yes it should, but I need to actually create the repo first
