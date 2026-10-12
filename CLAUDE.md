# Groundwork (working name)

## What this is

A dev tool you install in a project repo to kick off a new product. You explore the product idea as a 3D mind map in the browser, and the tool tells you whether you have enough to start building, what is missing, and what to add before you start. Everything is stored as plain files inside the project so Claude Code can read and act on it.

This is step one of a larger idea: an exploratory layer in the dev stack, in the spirit of Ray or the Symfony profiler. Later steps will write into the same folder: a progress page that traces every page back to the user stories behind it and argues when the page and its stories disagree, annotating the running product, interviewing colleagues about their feedback, and a "where should I focus" view. Keep the data model general enough for that, but do not build those parts now. The one exception is stories: the kickoff already produces them, so the chain from idea to story to code exists from day one.

## This repo's own `.groundwork/`

This repo uses Groundwork on itself. Its `.groundwork/` is the map of Groundwork as a product: the thoughts, the readiness checks, and what `/brief` wrote from them.

- The stories in `.groundwork/stories/` and everything in `.groundwork/outputs/`, including `CLAUDE.starter.md`, describe Groundwork as a product. They are not tasks for this session and not a backlog. Build only what the person asks for.
- `CLAUDE.starter.md` is an example output of `/brief`. Never copy it into this repo's CLAUDE.md.
- Use the map to check the tool against, and to answer "why does it work like this". Running the commands here (`/readiness`, `/brief` and the rest) is fine, since they only write inside `.groundwork/`.

In a product's own repo it is the other way around: there the stories are meant to steer the build.

## Principles

- **Lives in the project.** No accounts, no cloud, no database. The `.groundwork/` folder is the source of truth.
- **Human readable and diffable.** One node per markdown file. A person should be able to read the folder without the UI.
- **Capture is fast and loose.** Only a title is required. Never block capture with validation or forms.
- **Space means something.** 3D is not decoration. Position carries meaning (see Spatial model).
- **Claude thinks, the UI captures.** Evaluation and writing happen through Claude Code commands that read and write files. The UI captures, displays and reacts to file changes. No API key in v1.

## How it runs

From the root of any project:

```
npx groundwork init   # creates .groundwork/ and copies Claude Code commands; run again to update them
npx groundwork        # starts local server and opens the browser
npx groundwork --app http://localhost:5173   # also puts a Comment button on every page of the product
npx groundwork --lan                         # lets phones on the same Wi-Fi send comments (comments only)
npx groundwork import-feedback <file>        # adds comments a tester shared as a file
```

**Comments on the running product** become thoughts on the Feedback page, in a topic named after the screen (`source: app`, `seen_in` with the screen and element, the stories that cover the screen, and a picture on iOS):
- **Web:** `--app` runs a proxy in front of the dev server that adds `overlay/feedback.js` to each page. Live reload passes through. Nothing is written into the product.
- **iOS:** the debug-only Swift package in `clients/ios/GroundworkFeedback` posts to `/api/feedback`. It reads the tapped element through accessibility, so it works for SwiftUI and UIKit. On a phone it finds Groundwork with Bonjour (`_groundwork._tcp`), which `--lan` announces. That listener answers only `POST /api/feedback` and `GET /api/hello`. The phone keeps a list of waiting and sent comments (long press, then Show comments).
- **Without Groundwork running:** both keep comments on the device and send them later. A tester can share them as a file for `import-feedback`. A comment that arrives twice is kept once.

The local server serves the UI, exposes a small REST API for nodes, and watches `.groundwork/`. Changes made on disk (by Claude Code or by hand) are pushed to the browser live via server-sent events. Default port 7777.

During development of the tool itself, use `npm link` to run it inside a real project.

## Stack

- Node + TypeScript
- Vite for the UI
- `3d-force-graph` (built on three.js) for the scene, with `three-spritetext` for labels. Drop down to raw three.js only if the library blocks something we need.
- UI panels: Alpine.js + Tailwind (preferred), no heavy framework
- `gray-matter` for frontmatter, `chokidar` for file watching

## Data model

```
.groundwork/
  project.md            # name, one-line purpose, project type, page order, kickoff sign-offs
  commands.json         # which command versions init installed, so a later init updates only untouched ones
  nodes/
    <id>.md             # one node per file
  files/
    <node id>/<name>    # images pasted into a node, linked from its notes
  stories/
    <id>.md             # one user story per file, first written by /brief
  readiness/
    checklist.md        # what "ready" means for this project, editable
    report.md           # written by /readiness, shown in the UI
    gaps.json           # ghost nodes for the UI, written by /readiness
    design.json         # design scorecard: nine items, found, partly or missing, per platform when a repo holds several apps, written by /survey and /readiness
  outputs/
    survey.md           # state of an existing project and what /survey found, written by /survey
    brief.md            # written by /brief
    CLAUDE.starter.md   # starting context for building the actual product
```

A node file:

```md
---
id: n_8f2k
type: idea
title: Booking should feel like texting
topic: booking
altitude: 4
links: [n_2a9d, n_7c11]
status: open
created: 2026-10-02
---
Free text. Thoughts, references, half-formed questions.
```

- **type:** idea, audience, flow, feature, content, design, constraint, question, decision, reference
- **page:** optional. Which page of the map the node is on; without it, the first page. The page order lives in `project.md` as `pages: [Product, Feedback]`, and the UI also has an All page with everything.
- **topic:** optional. Groups nodes sideways in the map. Plain words, matched regardless of case. Set by hand, in the panel, or by `/topics`.
- **altitude:** 1 to 5. 5 is abstract (vision, feeling, principle), 1 is concrete (a field, a button, a specific screen).
- **status:** open, settled, parked
- **links:** undirected in v1. Store on both nodes. Links mostly stay inside a topic; topics do the grouping.
- **id:** short, random, stable. Never derived from the title.
- **source** and **seen_in** say where a thought came from, when a command wrote it from an existing project: `source: code`, `docs` or `commit` with the paths, doc anchors or commit ids in `seen_in` is evidence and may be settled; `source: inferred` is Claude's guess, always open, with a thread question. A thought the person writes has neither.
- **topic_by: claude** marks a topic Claude chose. Setting a topic yourself removes it, and commands never change a topic without it.

The notes can end in a thread, a dialog between the person and Claude:

```md
Free notes.

## Thread

**Claude asks** · 2026-10-03
Does "not too deep" mean one panel at a time?

**You** · 2026-10-03
Yes.
```

Entries are `**Claude asks**`, `**Claude**` or `**You**`, a dot and a date. A question is open until any entry follows it. A question can end in an `Options:` list of answers to pick from (`- ` lines); the UI offers them as buttons. Open questions are marked on cards and counted in the UI. Commands ask in threads when they are unsure instead of guessing.

`gaps.json` shape:

```json
[
  {
    "id": "gap_typography",
    "area": "design",
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

- **severity:** blocking, important or nice.
- **page, topic, altitude:** where the ghost card sits. A topic only gaps point at still gets a column, so an empty area shows.
- **answered_by:** set from the map when a ghost is answered (the answer becomes a node). `/readiness` checks that node and drops the gap when it closes it. Keep gap ids stable across runs.
- **enough:** set with `answered_by` when the person chose "Enough for now". The answer node is a settled decision titled "Enough for now: ...", and `/readiness` never raises that gap again.
- **suggestions:** two or three answers Claude proposes, `{title, why}`, written by `/readiness`. The person can start from one instead of a blank box.

`report.md` has `verdict:` (ready to build, ready to prototype, not ready) and `checked:` in its frontmatter, plus `closed:` and `added:` (gap titles since the check before), then the areas and the smallest set of things to add. `/readiness` narrows down: it keeps gap ids, adds a blocking gap only when something changed, and never raises an accepted one.

**The kickoff** has five steps: Map, Check, Answer, Brief, Build. The person signs each off; the files only inform (where things stand, and whether something changed since). Sign-offs live in `project.md` as `kickoff: { map: 2026-10-08, check: 2026-10-08 }`. Build hands off the starter CLAUDE.md for a new product, or only its story rules for an existing project.

A story file:

```md
---
id: s_k3f9
title: Book a desk in three steps
status: not-started
from: [n_2a9d, n_7c11]
applies_to: []
created: 2026-10-02
---
As someone arriving at the office, I want to book a desk in three steps,
so that booking never feels like a chore.

## Acceptance
- Booking takes at most three steps from the start page
- The booked desk is visible without opening a menu
```

- **status:** not-started, partial, done
- **from:** the map nodes the story came from. Every story must have at least one. This is the link back to the reasoning.
- **applies_to:** routes or component paths in the product. Empty at kickoff, filled in as the product is built.
- **id:** same pattern as nodes. Stories are cited by id in commits and code comments, so ids must never change.

Decisions stay as nodes with `type: decision`. Stories reference them through `from`.

## Spatial model

- **Y axis is altitude.** Abstract nodes float high, concrete nodes sit low, each altitude on its own faint guide line. Changing a node's altitude visibly moves it.
- **X axis is topic.** Each topic gets a column, left to right by name, with nodes without a topic in a "no topic" column at the right. Topics are the main grouping.
- **Z axis is time.** The most recently changed nodes (by the file's modified time) sit in front, untouched ones sink back and are a little dimmer.
- **Spread within a row comes from the force layout.** Links inside a topic pull nodes together. Links across topics are allowed but drawn faint and pull weakly, so they never merge two groups.
- **Nodes are word cards.** The title on a small dark card, the same size on screen at any zoom. A card with no room shows as a dot until hovered or zoomed in.
- **Color shows type,** as a thin edge on the card. Keep the palette calm and readable on a dark background.
- **Status shows as weight.** Settled has an outline in its type color, open is normal, parked is dimmed.
- **Stories are cards of their own kind,** in a row under the map, in the column of their first source thought, with faint lines to the thoughts they came from. They are not nodes; they live in `stories/`.
- **Readiness gaps are ghost nodes.** Translucent, outlined, placed near the cluster they relate to, labeled with what is missing. Clicking one shows why it matters and lets you answer it, which turns it into a real node.

## Interaction

- A rail at the far left switches views: **Focus** (only what needs the person, one item at a time: blocking gaps, Claude's questions, guesses from `/survey` to confirm, then the other gaps; each with its suggestions or options, an answer box, Skip, and for gaps "Enough for now"; the map stays visible, dimmed around the current item; it ends in "Nothing needs you right now" and the next command to run), **Map** (the 3D map with pages, topics and the list), **Readiness** (the kickoff steps on top, then the verdict, what closed since the last check, each checklist area, open gaps, gaps waiting for a check, and everything settled by topic) and **Deliverables** (the brief, the stories and the starter CLAUDE.md, written by `/brief`).
- Writing on a gap has three actions: "Add as a thought" leaves the gap open, "This answers it" sets `answered_by` so `/readiness` checks it next time, and "Enough for now" accepts it as it is, closed at once and for good. A remark never closes a gap by accident.

- Orbit, zoom, pan with the mouse.
- Click a node: the camera flies to it and a side panel opens. All text editing happens in the 2D panel, never inside the 3D scene.
- A quick capture bar is always available. Type and press Enter to create a node. Prefixes are optional: `?` makes a question, `!` makes a decision, with or without a space after.
- A new node captured while a node is selected links to it and takes its topic.
- `/` opens the list: every node grouped by topic, with counts that show thin topics. Typing filters, Enter opens.
- Keys: `N` new node (linked to the selection if any), `L` link mode, `[` and `]` move altitude, `/` list and search, `F` fit the map, `Delete` remove (press twice), `Esc` back.
- The UI follows a design tool's dark interface: icons (Heroicons, inlined) for tools and panel actions, with their name and key in a tooltip; words for content such as titles, topics and labels. Neutral greys, one blue accent, subtle shadows.

## Claude Code commands

Shipped with the package in `commands/` and copied into the host project's `.claude/commands/` on init.

- **/survey** starts the map from a project that already exists: it reads the code, docs and git history (read only) and writes thoughts for what is built, decided, half done or contradictory, each with `source` and `seen_in`; stories for what is built with `applies_to` filled in and status done or partial; the design scorecard; and questions where the why is missing. It never makes the map look more decided than the project is.
- **/decisions** looks back over a Claude Code session and its commits, settles the thoughts it decided (naming the commit), writes decision nodes for the rest, and asks in threads when unsure.
- **/import <file>** turns a document, such as a brief or a list of user stories, into nodes with the source line quoted in each.
- **/topics** reads all nodes and writes `topic:` into them: three to seven topics, reusing existing ones, never touching titles or notes. Ends with which topics look thin.
- **/readiness** reads `project.md`, all nodes and `checklist.md`. Judges each checklist area as missing, thin or enough, relative to the project type. Writes `report.md` and `gaps.json`. Ends with a clear verdict: ready to build, ready to prototype, or not ready, plus the smallest set of things to add.
- **/challenge** looks at the thinnest areas and asks three to five choice forcing questions: in the thread of the thought they concern, or as a new question node where an area is empty. This is the seed of the later interview feature.
- **/brief** writes `outputs/brief.md`, `outputs/CLAUDE.starter.md` and the first set of stories in `stories/`, one file each, every story linked to the nodes it came from. If readiness has blocking gaps, it says so at the top instead of hiding them.
- **/review** (later phase, do not build yet) reads a page's code and its stories and writes arguments: drift, orphans, conflicts, and requests that contradict earlier decisions. See PLAN.md Phase 6.

## Conventions

- Never write outside `.groundwork/` in the host project, except `.claude/commands/` during init.
- The UI must handle files being created, changed or deleted externally at any time.
- Keep it small. Prefer removing a feature over making capture slower.
- `CLAUDE.starter.md` must tell the product's Claude Code to cite story ids in commit messages, add the id in a short code comment where a story shapes behavior, update `applies_to` and `status` when it builds against a story, and ask before building something no story covers.
- Generated text (reports, briefs, questions) is plain and direct. Do not use the dash characters "–" or "—"; rewrite the sentence instead.
