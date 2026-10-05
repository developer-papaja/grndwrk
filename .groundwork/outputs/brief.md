---
written: 2026-10-05
---
# Groundwork

> **Not ready to build yet:** the kickoff flow from `groundwork init` to a deliverable is not written down (gap_kickoff_flow). This brief shows what is there. Readiness says ready to prototype; scope and a type scale are also still open.

## What it is
Groundwork is a dev tool that lives in a project repo, where you explore a product idea as a 3D map of thoughts and find out whether you have enough to start building. It answers what project management tools do not: a visual, documented ground for why things were decided, kept across Claude Code sessions instead of lost in them (n_rlee).

## Who it is for
For now, the person building it: a designer or developer who wants to ideate, move forward to building, and keep decisions documented in a visual way (n_rlee). It is an internal tool for the time being (n_mcjp). The wider aim is to help people ideate (n_jtdo, n_wncw).

## What success looks like
Hard to measure fully. Success is feeling that you build a better product faster thanks to the tool (n_sd94). Going forward with ideas should feel easy (n_adhc) and working with it should feel intuitive (n_vypj).

## Core flows

**Capture a thought**
1. Open the map in the browser.
2. Type a line in the capture bar at the bottom and press Enter (n_46od).
3. The new card lights up for a few seconds and a note says where it went (n_3cgp, n_7hoj).
4. If the same title already exists, nothing is added and the existing card is pointed out (n_so17).

**Develop a thought**
1. Click a card, or a row in the list (n_m1m5, n_u6e9).
2. The details panel opens on the right, docked, without leaving the map (n_low0, n_fjq5, n_ea3c).
3. Click the full title to edit it (n_dkno), write notes, paste or drop images (n_36d4).
4. Use the bottom bar to link, move higher or lower, or delete (n_46od).
5. Minimize or close the panel from its top (n_ea3c).

**Work with Claude**
1. Run a command in Claude Code: `/import` a document (n_5dqs), `/topics` to group (n_2sqo), `/decisions` at the end of a session (n_ax4k), `/challenge` for questions.
2. The files in `.groundwork/` change and the map updates live.
3. Where Claude is unsure it asks in a thought's thread; open questions are marked on cards and counted (n_97bu).
4. You answer in the thread. A question stays open until anything follows it (n_x0i6).

**Kick off a product** (not written in the map; see Open questions)
The map says where this should end: a site map or deliverable that explains what the product is and can be judged before moving forward (n_scwj). The steps between `groundwork init` and that deliverable are not written down. The commands suggest init, capture or import, topics, readiness, answer the ghost cards, brief, but the map has not decided this.

## Site map

- **Map** (the main view)
  - *Scene*: the 3D map of word cards. Height is altitude, sideways is topic, depth is when a node last changed (n_j35n, n_xlew). Flows: all.
  - *Left panel*: pages, with All first, then topics and the list of nodes grouped by topic, collapsible (n_6ztc, n_71ls, n_bljl). Flows: develop a thought.
  - *Details panel*: the open thought, its notes, images and thread, docked on the right (n_low0, n_dkno, n_97bu). Flows: develop a thought, work with Claude.
  - *Bottom bar*: capture plus Link, Higher, Lower, Delete (n_46od). Flows: capture, develop.
  - *First run*: an empty map tells you this is for starting to ideate, to create a new thought, and that commands sync what you have (n_brcp). Flows: kick off.
- **Readiness**: the verdict, the areas and the ghost cards for what is missing, with what is answered and what is not (n_0pvl, n_dtmw). Flows: kick off.
- **Deliverables** (direction, not decided): the brief, site map, decisions and scope shown as something better than a map (n_scwj, n_0so7). Flows: kick off.
- **Outside the browser**: `npx groundwork init`, `npx groundwork`, and the Claude Code commands. Flows: work with Claude, kick off.

The map does not decide how views are switched; n_scwj suggests a rail to the left of the left panel with tabs such as map, setup, insights and deliverables.

## In the first version
- Fast capture with one line, `?` and `!` prefixes, no duplicate cards (n_46od, n_so17).
- The spatial map: altitude, topic columns, time as depth, word cards (n_j35n, n_xlew, n_innn, n_394y).
- Pages above topics, with an All page (n_6ztc).
- The list on the left and the docked details panel on the right (n_u6e9, n_71ls, n_low0).
- Images in notes, saved in `.groundwork/files/` (n_36d4).
- Threads with Claude and counted open questions (n_97bu, n_x0i6).
- Commands: `/import`, `/topics`, `/decisions`, `/readiness`, `/challenge`, `/brief` (n_5dqs, n_ax4k, n_2sqo, n_0pvl).
- Readiness covering setup for building with Claude: CLAUDE.md, design docs, code standards, skills (n_0pvl).

## Not in the first version
The map decides nothing against. This is the scope gap (gap_scope). What it leaves for later:
- WCAG 2.0 AA: nice, not needed while internal (n_mcjp).
- Running `/topics` automatically (n_2sqo).
- Documents, not just images, held in the tool (n_a6nn).
- A deliverables view, and maybe setup and insights views (n_scwj).
- Sharing: the npm name and a license only matter once someone else installs it (gap_npm_name).

PLAN.md has a "Not now" list (in-app Claude via API, multiplayer, a flat 2D view, directed links, export beyond files). It is not in the map.

## Design foundation
- A design tool's dark interface: Heroicons for tools and panel actions, words for titles, topics and labels, neutral greys, one blue accent, subtle shadows (n_bz8p).
- Icons only where they are tools, not everywhere (n_iwro).
- Less text everywhere. Short labels, no hint sentences (n_3ith).
- Nodes are word cards, not orbs (n_394y, n_c8zq). Altitude guides show words, not numbers (n_ot5w).
- Navigation should feel easy, not deep; things open in a panel instead of navigating away (n_r4xs, n_low0).
- Type scale and spacing are not decided (gap_type_scale, n_wv4e).

## Technical
- Everything is plain files in `.groundwork/`, and the folder is committed to git with the code (n_ax4k).
- Images live in `.groundwork/files/<node id>/` and are linked from notes as markdown (n_36d4).
- Commands never change a topic you set yourself (n_2sqo).
- Links stay inside a topic; links across topics are faint and pull weakly (n_xlew, n_uai4).
- The map says little else about the stack; it is decided in the repo's CLAUDE.md (Node, TypeScript, Vite, 3d-force-graph, Alpine, Tailwind).

## Constraints
- Internal tool for now (n_mcjp).
- No deadline in the map.
- "groundwork" is taken on npm (gap_npm_name).

## Open questions
- What are the steps of the kickoff flow, from init to a deliverable that can be judged? (n_scwj, gap_kickoff_flow)
- What does the first version not do, and where is that shown? (n_0so7, gap_scope)
- What type scale and spacing? (n_wv4e, gap_type_scale)
- How should views be switched, and is there a deliverables view? (n_scwj)
- How do you keep track of what has been answered and what has not? (n_dtmw)
- What is the best way to show an idea? (n_3zw8)
- The floor is still a little hard to navigate. What would fix it? (n_fgvo)
- Where do documents and reference sets live, beyond images? (n_a6nn)
- Should `/topics` run by itself? (n_2sqo)
