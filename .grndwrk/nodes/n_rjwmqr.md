---
id: n_rjwmqr
type: idea
title: The agent does nothing in the map unless asked, because it never sees the map's rules
topic: working with Claude
page: Feedback
altitude: 3
links: []
status: settled
created: 2026-11-16
built: 2026-11-16
---
In the last couple of days, chatting with Claude has not done anything in grndwrk unless asked specifically about it. Should it not do that, or ask about it?

Why: the map's rules are in `.grndwrk/CLAUDE.md`, and Claude Code reads a CLAUDE.md in a subfolder only when it opens a file there. In an ordinary chat about the code it never opens `.grndwrk/`, so it never learns the map exists. init gives Codex a line for the root AGENTS.md; Claude Code gets nothing at the root.

Proposal: init asks to add a short block to the project's root CLAUDE.md (and AGENTS.md), or prints it: the map exists, follow `.grndwrk/CLAUDE.md`. Bookkeeping it just does (built with steps to test, questions into the map, ticking stories, the first focus item); decisions from the chat it asks about once at the end of a piece of work, so the map holds only what the person agrees with.