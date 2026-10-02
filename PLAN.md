# Build plan

One phase per Claude Code session. Start each in plan mode, commit when the done criteria pass. From Phase 2 on, use the tool on a real upcoming product idea instead of test data.

## Phase 0: Scaffold

- Package with a `groundwork` bin, `init` and default `start` commands
- Local server: serves the UI, REST endpoints for nodes (list, create, update, delete), file watcher, server-sent events
- Vite UI with an empty 3D scene that orbits
- `init` creates `.groundwork/` with `project.md`, `nodes/`, `readiness/checklist.md` (from the template below) and copies commands

**Done when:** `npm link`, then `npx groundwork init` and `npx groundwork` inside another repo opens an empty scene, and the folder exists.

## Phase 1: The map

- Read nodes from disk and render them with `3d-force-graph`
- Quick capture bar, side panel for editing, links between nodes
- Every change writes to the node's markdown file
- External file edits show up in the browser without reload

**Done when:** you can capture 20 thoughts in a few minutes, link them, close the browser, edit a file by hand, reopen, and everything is there and correct.

## Phase 2: Space that means something

- Y axis locked to altitude, `[` and `]` move nodes
- Type colors, status weights, readable labels at distance
- Camera fly-to on select, search with `/`

**Done when:** looking at the map, you can tell at a glance where the abstract thinking is, where the concrete detail is, and which areas are empty.

## Phase 3: Readiness

- Write `/readiness` and `/challenge` as Claude Code commands
- UI shows `report.md` in a panel and `gaps.json` as ghost nodes
- Answering a ghost node creates a real node and marks the gap for re-check

**Done when:** running `/readiness` on a real idea gives a verdict you agree with, and the ghost nodes point at things you actually had not thought about.

## Phase 4: Outputs

- Write `/brief`
- `/brief` writes the first stories as files, each linked to the map nodes it came from
- Stories show in the map as their own node type, connected to their source nodes
- `CLAUDE.starter.md` should be good enough to start a new product repo with, including the traceability conventions (story ids in commits and comments, update `applies_to` and `status`, ask before building something no story covers)

**Done when:** you start building a real product from the generated starter file, the first few prompts land without you re-explaining the idea, and the first commits cite story ids without you asking.

## Phase 5: Use it, then decide

Use it for two kickoffs. Note what you skip, what you wish existed and where it felt slow. Check that story ids actually end up in commits and `applies_to` gets filled in, since Phase 6 depends on it. Only then build the next layer.

## Phase 6: Progress and review

Needs a running product with stories linked to it.

**Progress page.** A view listing every route or component that appears in any story's `applies_to`. For each one: the stories behind it, their status, and the map nodes and decisions those stories came from. Clicking through goes story, then node, then decision. A summary at the top shows done, partial and not started across the project.

**/review.** Reads a route's code (later also screenshots via Playwright) against its stories and the design foundation. Writes `.groundwork/reviews/<route>.md` with arguments of four kinds:

1. **Drift:** the page does not do what a story says
2. **Orphan:** something exists that no story asks for
3. **Conflict:** two stories pull against each other and the page picked a side silently
4. **Contradiction:** a recent change goes against an earlier decision node

Each argument names the story or decision it rests on, so it can be checked.

**Dismissing is first class.** Every argument has a dismiss action that asks for one line of why. That line becomes a decision node linked to the argument, and `/review` reads decisions before arguing, so the same point is never raised twice. Overruling the tool feeds the memory it argues from.

**Done when:** running `/review` on a real page produces arguments you mostly agree with, dismissing one takes seconds, and the progress page can answer "why does this page work like this?" without you opening the code.

## After that

Overlay on the running product, colleague interviews, focus view. Plan these only after Phase 6 has been used for a while.

## Not now

- In-app Claude via API
- Multiplayer or sharing
- Flat 2D view toggle
- Directed links, link types
- Exporting anywhere except files

## Readiness checklist template

Copied to `.groundwork/readiness/checklist.md` on init. Edit per project; a small internal tool needs less than a public product.

**Purpose.** Who it is for, what problem it solves, what success looks like.
Enough when: you can say it in two sentences and someone else agrees.

**Core flows.** The one to three journeys that matter, start to end.
Enough when: each flow has a start, an end and the steps between.

**Scope.** What is in the first version and what is explicitly out.
Enough when: there is at least one thing you decided not to build.

**Content and tone.** What real content exists, how the product speaks.
Enough when: you could write the start page copy without guessing.

**Design foundation.** Typography, color, spacing, core components, references or mood, accessibility baseline.
Enough when: a prompt can produce consistent screens without inventing a style.

**Technical.** Platform, stack, data, integrations, auth.
Enough when: you know what you are building on and what it must talk to.

**Constraints.** Deadline, budget, legal, hosting, client demands.
Enough when: nothing here would surprise you halfway through.

**Open questions.** Unanswered questions that block a core flow.
Enough when: none of them are blocking.

## First prompt for Claude Code

> Read CLAUDE.md and PLAN.md. We are starting Phase 0. In plan mode, propose the package structure, dependencies and server design before writing any code. Point out anything in the data model you think will cause problems later.
