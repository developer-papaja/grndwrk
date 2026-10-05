---
id: n_5dqs
type: question
title: Would it be possible to start this by adding a document, like and md-file or import a list of like user stories
topic: working with Claude
topic_by: claude
page: Product
altitude: 3
links: [n_scwj]
status: settled
created: 2026-10-03
---
Answer from Claude:

Yes, and it is cheap. A /import command: you give Claude Code a file, for example a brief or a list of user stories, and it writes one node per thought, with type, altitude, topic and links, and quotes the source line in the notes. Nothing changes in the map itself.

Done in 37113ff: /import <file> turns a document into thoughts and quotes the source line in each.
