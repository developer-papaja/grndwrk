---
id: n_xpkx57
type: decision
title: Second security read of the relay, before pushing
topic: working with Claude
page: Feedback
altitude: 2
links: [n_0fe7zi]
status: settled
created: 2026-11-09
built: 2026-11-09
---
You asked for it in the chat: a security check of the relay before we push. Read only, from the source; nothing was sent to the deployed relay.

What holds: signing and replay at the relay, the owner key, phones only reaching their own outbox and their own comments, removing a phone, one-time invites, the relay never seeing keys or comment text, and comments through the relay handled like --lan ones.