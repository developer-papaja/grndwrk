---
description: Write the decisions made in this Claude Code session into the Groundwork map
---
Look back over this conversation and write the decisions made in it into this project's Groundwork map, so the map keeps up with what was actually decided.

## What counts as a decision

Something the person and you settled during this session: a choice between options, a rule to follow, something built that answers an open thought, or something explicitly ruled out. Ideas that were only floated are not decisions. Skip routine steps such as fixing a typo or running tests.

Also look at the commits made during this session (`git log` since the session started, if this is a git repository). A commit usually carries the decision behind it.

## Read the map first

1. `.groundwork/project.md`: what the project is, and `pages:` for the page order.
2. Every file in `.groundwork/nodes/`. Frontmatter fields: `id`, `type`, `title`, `topic`, `topic_by`, `page`, `altitude`, `links`, `status`, `created`. Free notes below, and maybe a `## Thread` section (format below).

## Write

For each decision:

- **If it answers or settles a thought that is already in the map,** set that node's `status: settled` and add one line at the end of its notes, above any `## Thread`: what was done, and the commit id if there is one. Example: `Done in 55bf9ca: the right panel is docked, with Minimize and Close at the top.`
- **Otherwise,** create a new node file `.groundwork/nodes/<id>.md`. The id is `n_` plus four random lowercase letters or digits, and must not already exist. Use `type: decision`, `status: settled`, today's date as `created`, a short title in plain words, the page and topic it belongs to (with `topic_by: claude` when you chose the topic), and an altitude (5 vision, 4 principle, 3 approach, 2 feature, 1 detail). Link it to the thoughts it settles. Links are two-sided: add the id on both nodes. Keep links inside one topic where you can.

Frontmatter order: `id, type, title, topic, topic_by, page, altitude, links, status, created`. Write `links` on one line, like `links: [n_ab12, n_cd34]`.

**When you are not sure what was decided,** do not guess. Add a question to the thread of the most related node instead:

```md
## Thread

**Claude asks** · 2026-10-03
Did we decide that pages replace topics, or sit above them?

Options:
- Pages replace topics
- Pages sit above topics
```

Add `## Thread` once, at the end of the node's notes, if the node has none yet. New entries go at the end of the thread. A question stays open until any entry comes after it.

**When a decision answers a question that is open in a thread,** close it with an entry that says what was decided and where:

```md
**Claude** · 2026-10-03
Answered in this session: a magic link to the work email (9b17e02).
```

Write only inside `.groundwork/nodes/`. Never change titles the person wrote, and never delete files. The map in the browser updates live.

## Report

End with a short plain list: what you settled, what you created, and what you asked. Write plainly and directly. Do not use the dash characters "–" or "—".
