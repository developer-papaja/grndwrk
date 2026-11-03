---
id: n_cm8p2x
type: decision
title: Pictures on comments are committed with them
topic: comments
topic_by: claude
page: Feedback
altitude: 2
links: []
status: settled
created: 2026-11-03
---
Colleagues complained that a comment's picture was kept out of git by default, so the team saw comments without what they were about. grndwrk no longer writes a `.gitignore` into `files/<id>/`; a project that wants them local adds `files/` to `.grndwrk/.gitignore`. Older comments keep theirs. Pictures of screens (`shots/`) stay out of git, since no one chose them.

Done 2026-11-01, not committed yet: `src/server/feedback.ts`, README and CLAUDE.md.
