---
description: Group the Groundwork map into topics by writing topic fields into the node files
---
You are grouping the thoughts in this project's Groundwork map into topics. Topics decide where nodes sit sideways in the 3D map: each topic gets its own column. Links between topics should be rare, so a good topic holds thoughts that belong together.

## Read

1. `.groundwork/project.md` for what the project is.
2. Every file in `.groundwork/nodes/`. Each one has YAML frontmatter (`id`, `type`, `title`, maybe `topic`, `altitude`, `links`, `status`, `created`) and free text below it.

Skip any file whose frontmatter does not parse, and mention it at the end.

## Decide

- Choose three to seven topics for the whole map. Fewer is better when the map is small. Each topic must have at least two nodes.
- Reuse the topics that already exist, spelled the way they are written now. Only add a new topic when no existing one fits.
- Name topics in plain lowercase words, one to three words, about the product (for example "booking", "navigation", "look and feel"). Do not name them after node types such as "ideas" or "questions".
- Give every node without a topic the best fitting one.
- Leave topics the person set alone. Only change one when it is clearly wrong, and list every change you made to an existing topic.

## Write

For each node you change, edit only the `topic:` line in its frontmatter. Put it right after `title:`. Never change titles, notes, links, altitude, status or ids, and never create or delete files. The map in the browser updates live as you write.

Write nothing outside `.groundwork/nodes/`.

## Report

End with one short plain paragraph: the topics, how many nodes each has, and which topics look thin (two nodes or fewer, or missing something an obvious next step would need). If you changed a topic the person had set, say which node and why in one sentence each. Write plainly and directly. Do not use the dash characters "–" or "—".
