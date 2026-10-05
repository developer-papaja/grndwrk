---
description: Judge whether the Groundwork map is ready to build, and write the report and the gaps
---
Judge whether this project's Groundwork map holds enough to start building, and write down exactly what is missing.

## Read

1. `.groundwork/project.md`: name, purpose, project type, and `pages:` for the page order.
2. `.groundwork/readiness/checklist.md`: what "ready" means for this project. Each area has an "Enough when" line. The person may have edited it; follow their version.
3. Every file in `.groundwork/nodes/`: frontmatter (`id`, `type`, `title`, `topic`, `page`, `altitude`, `links`, `status`) and the notes, including any `## Thread`. A settled thought counts more than an open one. A thread answer from the person counts as settled for what it answers.
4. The previous `.groundwork/readiness/report.md` and `gaps.json`, if they exist. A gap with `answered_by` was answered from the map: read that node and decide whether the gap is closed now.
5. For the "Setup for building with Claude" area, also look at the project itself, outside `.groundwork/` (read only): is there a `CLAUDE.md`, design docs or references, code standards or linting config, and skills or commands in `.claude/`?

A thought with `answers: gap_x` was written as the answer to that gap; its first note line says which gap and why it mattered. Judge the gap against it.

Some thoughts say where they came from with `source:` and `seen_in:` (written by `/survey`). `source: code`, `docs` or `commit` with a `seen_in` is evidence: it counts as what exists. `source: inferred` is Claude's guess: it counts as open until the person has answered its thread.

## Judge

For each checklist area, decide: **missing**, **thin** or **enough**, relative to the project type. A small internal tool needs much less than a public product. Be honest and specific: "thin" must name what is thin.

Then pick one verdict:
- **ready to build**: nothing blocking is left.
- **ready to prototype**: the purpose and at least one core flow are clear, but parts that a real build needs are missing.
- **not ready**: the purpose or every core flow is still unclear.

## Write `.groundwork/readiness/report.md`

```md
---
verdict: not ready
checked: 2026-10-03
---
One or two sentences: the verdict and the main reason.

## Areas

**Purpose: enough.** Why, in one or two lines.
**Core flows: thin.** What exactly is missing.
...

## The smallest set of things to add

1. The first thing, said so the person can act on it.
2. ...
```

## Update `.groundwork/readiness/design.json`

The design scorecard: nine fixed items (design docs, colors as tokens, typography, spacing scale, radius and shadows, shared components, icons, references, accessibility), each `found`, `partly` or `missing`, with a one line `note` and `seen_in`. If the file exists, check each item again against the map and, read only, the project (for example a type scale decided in the map, or tokens added to the code), and update what changed. If it does not exist, write it. Base the Design foundation area of the report on it.

```json
[{ "item": "typography", "status": "partly", "note": "One font, no type scale.", "seen_in": ["ui/src/style.css"] }]
```

## Write `.groundwork/readiness/gaps.json`

One entry per concrete thing that is missing or thin. Not one per area: a thin area can have two gaps, an enough area none.

```json
[
  {
    "id": "gap_typography",
    "area": "design foundation",
    "title": "No typography decided",
    "why": "Prompts will invent a type scale per screen",
    "near": ["n_3k1a"],
    "severity": "blocking",
    "page": "Product",
    "topic": "look and feel",
    "altitude": 2
  }
]
```

- `id`: `gap_` plus a short slug. Keep the same id for the same gap across runs, so answers stay attached.
- `title`: what is missing, in a few plain words. It shows on a card as "Missing: <title>".
- `why`: one sentence on what goes wrong if it stays missing.
- `severity`: `blocking` (stops a real build), `important` (will cost rework), or `nice`.
- `page` and `topic`: where the ghost card sits in the map. Use an existing page and topic when one fits. A topic with no thoughts yet is fine and makes the empty area visible as its own column.
- `altitude`: 5 vision, 4 principle, 3 approach, 2 feature, 1 detail.
- `near`: ids of the closest related thoughts, when there are any.
- Drop a gap whose `answered_by` node closes it. Keep it, without `answered_by`, if the answer was not enough, and say why in the report.

Write only those three files, inside `.groundwork/readiness/`. Never edit nodes: questions for the person belong to `/challenge`. Write plainly and directly. Do not use the dash characters "–" or "—".

## Report back

End with the verdict in one sentence, then the smallest set of things to add as a short list.
