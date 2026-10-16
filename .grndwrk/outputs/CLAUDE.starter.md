# grndwrk

A dev tool that lives in a project repo. You explore a product idea as a 3D map of thoughts, and it tells you whether you have enough to start building. It is for a designer or developer who wants to ideate, move forward to building, and keep decisions documented visually across Claude Code sessions. Internal tool for now. Success: you feel you build a better product faster because of it.

Read `.grndwrk/outputs/brief.md` for the full picture and `.grndwrk/stories/` for what to build.

## Core flows
- **Capture:** type a line in the bottom bar, Enter. The card lights up; a duplicate title adds nothing.
- **Develop:** click a card or list row, edit in the docked right panel, link, move altitude, paste images.
- **Work with Claude:** commands write files in `.grndwrk/`, the map updates live, Claude asks in threads.
- **Kick off:** not decided yet. Ends in a brief and site map that can be judged. Ask before shaping it.

## Site map
- Map: 3D scene, left panel (pages, topics, list), right details panel, bottom capture bar and tools
- Readiness: verdict, areas, ghost cards for gaps
- Deliverables: a direction only. Do not build it without a story.

## Rules
- All data is plain files in `.grndwrk/`, committed to git. No database, no accounts.
- Height is altitude, sideways is topic, depth is when a node last changed.
- Links stay inside a topic. Links across topics are faint and pull weakly.
- Nodes are word cards, never orbs. Altitude guides show words, not numbers.
- Clicking opens a panel. Never navigate away from the map.
- Never change a topic the person set themselves.
- Dark design tool interface: Heroicons for tools and panel actions only, words for content, neutral greys, one blue accent, subtle shadows.
- Do not use icons everywhere. Icons are for tools.
- Type scale and spacing are not decided. Reuse existing sizes; do not invent new ones per panel.

## Not in the first version
- Do not build WCAG 2.0 AA work beyond basics; it is not needed while this is internal.
- Do not make `/topics` run automatically.
- Do not add document storage beyond images in notes.
- Do not build a deliverables, setup or insights view without a story.
- Do not prepare for sharing (npm name, license) yet.

## How to write
- Less text everywhere. Short labels, no hint sentences.
- Plain and direct. Do not use the dash characters "–" or "—".
- First run copy: this is meant for you to start ideating, create a new thought to get started, and commands sync what you have.

## Working with stories
Stories live in `.grndwrk/stories/`, one file each. Each links back to the map nodes it came from.

1. Cite the story id in every commit message that implements or changes a story, for example "Capture a thought in one line (s_q7m2)".
2. Where a story shapes behavior, add the id in a short code comment, for example `// s_q7m2: same title adds nothing`.
3. When you build against a story, update its `applies_to` with the routes or component paths, and its `status` to `partial` or `done`, in `.grndwrk/stories/`.
4. Before building something no story covers, stop and ask.
