---
description: Turn the Groundwork map into a brief, a site map, the first user stories and a CLAUDE.md to start building with
---
Turn this project's Groundwork map into what someone needs to start building the product: a brief, a site map, the first user stories, and a starting CLAUDE.md for the product's own repository.

## Read

1. `.groundwork/project.md`: name, purpose, project type, `pages:`.
2. Every file in `.groundwork/nodes/`: frontmatter (`id`, `type`, `title`, `topic`, `page`, `altitude`, `links`, `status`) and notes, including threads. Settled thoughts and decisions carry the most weight. A thread answer from the person counts as decided.
3. `.groundwork/readiness/report.md` and `gaps.json`, if they exist.
4. Existing `.groundwork/stories/*.md` and `.groundwork/outputs/*.md`, if they exist. Update them; never duplicate them.

Use only what the map says. Where the map is silent, say so in the brief instead of inventing an answer.

## Write `.groundwork/outputs/brief.md`

```md
---
written: 2026-10-03
---
# <Product name>

> One line on readiness. If gaps.json has a blocking gap that is not answered, start with:
> **Not ready to build yet:** <the blocking gaps, in a few words each>. This brief shows what is there.

## What it is
Two sentences: what the product is and the problem it solves.

## Who it is for
## What success looks like

## Core flows
Each flow as numbered steps from start to end.

## Site map
Every screen, page or view the product needs, as a short nested list. For each: what it is for, in one line, and which flows pass through it.

## In the first version
## Not in the first version
Things decided against, and things the map leaves for later.

## Design foundation
## Technical
## Constraints

## Open questions
What the map leaves undecided that the build will run into, each with the node id it comes from.
```

Write plainly. Cite node ids in brackets, like (n_bz8p), where a statement rests on a specific thought, so it can be traced.

## Write the stories, one file each, in `.groundwork/stories/`

One story per thing a person can do or get from the product, covering every core flow. Aim for five to twelve for a first version. Fewer, larger stories beat many tiny ones.

```md
---
id: s_k3f9
title: Book a desk in three steps
status: not-started
from: [n_2a9d, n_7c11]
applies_to: []
created: 2026-10-03
---
As someone arriving at the office, I want to book a desk in three steps,
so that booking never feels like a chore.

## Acceptance
- Booking takes at most three steps from the start page
- The booked desk is visible without opening a menu
```

- `id`: `s_` plus four random lowercase letters or digits. Never change the id of a story that exists.
- `from`: the node ids the story came from. Every story needs at least one. This is the link back to the reasoning.
- `applies_to`: stays empty. It is filled in while building.
- `status`: `not-started` for new stories. Keep the status of stories that exist.
- Acceptance: two to five checks someone can actually test.
- When a story already exists for the same thing, update its text and acceptance instead of writing a new one.

## Write `.groundwork/outputs/CLAUDE.starter.md`

The starting CLAUDE.md for the product's own repository. It is read by Claude Code at the start of every session, so it must be short, concrete and true to the map:

- what the product is, who it is for, and what success is
- the core flows and the site map, in brief
- the design foundation and technical decisions, as rules
- what is not in the first version, as rules ("Do not build ...")
- how to write: the tone and wording rules from the map

It must end with a section on working with stories, with these four rules, in these words or close to them:

1. Cite the story id in every commit message that implements or changes a story, for example "Book a desk in three steps (s_k3f9)".
2. Where a story shapes behavior, add the id in a short code comment, for example `// s_k3f9: at most three steps`.
3. When you build against a story, update its `applies_to` with the routes or component paths, and its `status` to `partial` or `done`, in `.groundwork/stories/`.
4. Before building something no story covers, stop and ask.

Write only inside `.groundwork/outputs/` and `.groundwork/stories/`. Do not edit nodes. Do not use the dash characters "–" or "—".

## Report back

A short plain paragraph: whether the brief starts with the not ready warning and why, how many stories you wrote or updated, and the two or three open questions that matter most for the build.
