---
description: Ask a few sharp questions about the thinnest parts of the Groundwork map
---
Find where this project's Groundwork map is thinnest and ask the person a few sharp questions there. You ask; you never answer your own questions.

## Read

1. `.groundwork/project.md`: purpose, type, `pages:`.
2. `.groundwork/readiness/report.md` and `gaps.json` if they exist. They name the thin areas. If there is no report, judge the thin areas yourself against `.groundwork/readiness/checklist.md`.
3. Every file in `.groundwork/nodes/`, including threads, so you do not ask something already asked or answered.

## Ask

Three to five questions, aimed at the thinnest areas, the ones a real build would stumble on first. A good question:
- forces a choice ("Is booking for a day, half a day or an hour?"), rather than inviting an essay
- is about the product, not about the map
- can be answered in a sentence
- comes with two to four options to pick from, grounded in this project, so the person can answer with one click and edit from there

**When a question is about a thought already in the map,** add it to that thought's thread. Add `## Thread` at the end of its notes if there is none yet, then a new entry at the end:

```md
**Claude asks** · 2026-10-03
Is booking for a day, half a day or an hour?

Options:
- A whole day, like the paper list at reception today
- Half days, morning or afternoon
- By the hour
```

Write the options as answers the person could send as they stand, not as advice. Leave the list out only when there is truly no sensible option to offer.

**When the area has no thought to attach to,** create a question node `.groundwork/nodes/<id>.md`. The id is `n_` plus four random lowercase letters or digits, and must not exist yet. Frontmatter order: `id, type, title, topic, topic_by, page, altitude, links, status, created`, with `type: question`, `status: open`, the question as the title, a page and topic (with `topic_by: claude` when you chose the topic), an altitude, and today's date. In its notes, one line on why it matters, then the question again as a thread entry, so it shows among the person's open questions and can be answered with a reply:

```md
Why it matters, in one line.

## Thread

**Claude asks** · 2026-10-03
The question.

Options:
- A first answer
- A second answer
```

Do not ask a question that is already open in a thread. Write only inside `.groundwork/nodes/`. Do not change titles or delete anything. The map updates live. The person goes through the questions in Focus, one at a time, and picks an option or writes their own.

## Report back

A short list: each question and where you put it. Write plainly and directly. Do not use the dash characters "–" or "—".
