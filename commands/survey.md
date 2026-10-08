---
description: Start the Groundwork map from a project that already exists, by reading its code, docs and history
---
This project already exists. Read what is built, what is documented and what the history says, and write it into the Groundwork map, so the map starts from where the project really is. You only read the project; you write only inside `.groundwork/`.

The one rule above all: **code shows what exists, rarely why.** Never make the map look more decided than the project is. Every thought you write says where it came from, and only real evidence counts as settled.

## Read

1. **The shape of the repo:** top level folders, package files, framework and stack config, routes and pages (or screens and navigation: SwiftUI views, view controllers, navigation stacks), components, data models or schemas, environment and deploy config, tests. In an Xcode project, read the folders and Swift files directly; the `.xcodeproj` file itself only lists them.
2. **Docs:** README, CLAUDE.md, a `docs/` folder, ADRs, design files, CHANGELOG, and code comments that state a decision ("we do X because Y").
3. **History,** if this is a git repository: `git log --oneline -300`, and the full message of commits whose subject suggests a choice was made.
4. **`.groundwork/` as it is now:** `project.md`, every node, every story. If this is a re-run, add only what is new. A thought is already there when a node has the same meaning or the same `seen_in`.

## Write the thoughts, in `.groundwork/nodes/`

Each thought is one file, `.groundwork/nodes/<id>.md`. The id is `n_` plus four random lowercase letters or digits that do not exist yet. Frontmatter order:

`id, type, title, topic, topic_by, page, altitude, links, status, created, source, seen_in`

Two fields say where the thought came from:

```md
source: code
seen_in: [src/routes/booking.ts, src/components/DeskMap.tsx]
```

- `source: code`: you saw it in the code. It may be `status: settled`.
- `source: docs`: a document says it. It may be settled. Put the file in `seen_in`, with a heading anchor when there is one (`README.md#booking`).
- `source: commit`: a commit message states the decision. It may be settled. Put the short commit id in `seen_in`.
- `source: inferred`: you are guessing, usually about why something is the way it is. **Always `status: open`,** and add a thread question asking whether it is so:

  ```md
  ## Thread

  **Claude asks** · 2026-10-05
  Booking stops at three steps everywhere. Is that a rule, or how it happened to turn out?

  Options:
  - A rule: booking never takes more than three steps
  - How it turned out; it can change
  ```

What to write:
- **Features and screens as they exist:** what a person can see and do. `type: feature` or `flow`, altitude 1 or 2, `source: code`, settled.
- **Principles and decisions** found in docs or commit messages: `type: decision` or `design` or `constraint`, altitude 3 to 5, settled.
- **What is half built, marked TODO, or where docs and code disagree:** open, with one line in the notes on what you saw. A contradiction gets a thread question.
- **Reasons you can only guess:** `source: inferred`, open, with the question.

Titles are short, plain statements, not file names: "Desks are booked from a floor plan", not "DeskMap.tsx".

In the notes, one or two lines on what you saw, for example "The booking form posts to /api/bookings and caps the steps at three."

**Pages:** if `project.md` has no `pages:` yet, add `pages: [Product, Built]`. Product holds the purpose, principles and decisions. Built holds what exists as features and screens. Keep the pages the project already has.

**Topics:** reuse existing topics. Otherwise choose three to seven per page, plain words about the product, lowercase except names (the map shows the first letter capitalised), with `topic_by: claude`. Link thoughts that belong together inside a topic. Links are two-sided: add the id on both nodes.

**Size:** write at most about 60 thoughts on a first run, most important first: the core of what the product does, then its decisions, then details. Say in the report what you left out.

## Check the design foundation

Score the project's design foundation on nine fixed items, so the person can see at a glance how well the design is set up for building more screens consistently. Look in the places this kind of project keeps them:

- **Web:** CSS custom properties, a Tailwind or theme config, token files (JSON, SCSS, TS), a component folder.
- **iOS and macOS (Swift, SwiftUI, UIKit):** named colors in `Assets.xcassets`, `Color` and `Font` extensions or a theme type, `ViewModifier`s and shared views, SF Symbols, Dynamic Type, accessibility labels and traits.
- **Android:** `colors.xml`, `themes.xml`, `dimens.xml`, Compose `MaterialTheme`, shared composables.
- **Anywhere:** design docs, linked Figma files, lint config (for example SwiftLint or ESLint).

For each item, decide **found**, **partly** or **missing**, write one plain line on what you saw, and list where you looked or found it in `seen_in`:

1. **design docs:** a written design guide, style guide or design section in the docs.
2. **colors as tokens:** colors defined once as variables, theme values or named asset colors, and used from there rather than as hex or RGB values all over the code. Partly when tokens exist but many views still hardcode colors.
3. **typography:** font families, and a type scale (named sizes and line heights, or text styles such as Dynamic Type) instead of one off sizes.
4. **spacing scale:** spacing from a scale or theme instead of arbitrary values.
5. **radius and shadows:** corner radius and shadows as tokens or a short fixed set.
6. **shared components:** reusable UI primitives (buttons, fields, panels) instead of the same markup repeated.
7. **icons:** one icon set (for example SF Symbols or Heroicons), used the same way everywhere.
8. **references:** design references in the repo or linked: Figma, screenshots, a mood board.
9. **accessibility:** a stated baseline (for example WCAG AA), or checks such as an accessibility lint rule, focus styles and contrast. On iOS: Dynamic Type support, accessibility labels on controls and images, and enough contrast in both light and dark mode.

Write `.groundwork/readiness/design.json`:

```json
[
  { "item": "colors as tokens", "status": "found", "note": "Defined once in @theme and used through Tailwind classes.", "seen_in": ["ui/src/style.css"] },
  { "item": "typography", "status": "partly", "note": "One font is set, but sizes are picked per component and there is no scale.", "seen_in": ["ui/src/style.css", "ui/index.html"] }
]
```

Use the item names exactly as above, all nine of them.

**More than one app in the repo** (for example an iOS app and an Android app, or an app and a website): score each app on its own, since each keeps its own colors, type and components. Write all nine items once per app, each with `"platform": "iOS"`, `"Android"` or `"Web"`. Then add one more item, `"item": "shared across platforms"` with `"platform": "All"`: **found** when colors, type and icons are defined once (shared tokens, a generator such as Style Dictionary, or a cross platform UI layer) or clearly kept in step, **partly** when the names match but the values are kept by hand in each app, **missing** when each app defines its own. With one app, leave `platform` out.

```json
[
  { "platform": "iOS", "item": "colors as tokens", "status": "found", "note": "Named colors in Assets.xcassets, used through a Color extension.", "seen_in": ["App/Assets.xcassets", "App/Theme/Color+Brand.swift"] },
  { "platform": "Android", "item": "colors as tokens", "status": "partly", "note": "colors.xml exists, but many composables use Color(0xFF...) directly.", "seen_in": ["android/app/src/main/res/values/colors.xml"] },
  { "platform": "All", "item": "shared across platforms", "status": "partly", "note": "Same color names on both, values copied by hand.", "seen_in": ["App/Assets.xcassets", "android/app/src/main/res/values/colors.xml"] }
]
```

Also write one thought per item that is found or partly, in a topic named "design foundation" on the Product page, with `source: code` or `docs` and the same `seen_in`, so the map holds the design that exists. Missing items need no thought: the scorecard and `/readiness` cover them.

## Fill in `project.md`

Only fields that are empty: `purpose` (one line, from the README or what the code does) and `type` (for example internal tool, public product, client website). Never change a name, purpose or type the person wrote.

## Write stories for what is built, in `.groundwork/stories/`

One story per thing a person can do with the product today, in the format from `/brief`:

```md
---
id: s_k3f9
title: Book a desk from the floor plan
status: done
from: [n_2a9d, n_7c11]
applies_to: [src/routes/booking.ts, src/components/DeskMap.tsx]
created: 2026-10-05
---
As an employee, I want to pick a desk on the floor plan, so that I sit where I like.

## Acceptance
- The floor plan shows free and taken desks
- Booking takes at most three steps
```

- `status`: `done` when the code covers it and tests exist for it, `partial` when it is half built or untested. Never `not-started` here.
- `applies_to`: the routes and component paths that implement it. Only paths that exist.
- `from`: the thoughts it rests on. Every story needs at least one.
- Keep the ids and status of stories that already exist; update them instead of writing new ones.

## Ask

Three to five sharp questions, in the threads of the thoughts they concern, where the why is missing and it matters for what comes next. Each forces a choice, can be answered in a sentence, and ends with an `Options:` list of two to four answers the person could pick as they stand. The `source: inferred` questions count toward these.

Write only inside `.groundwork/`. Never change code, docs or config. Do not use the dash characters "–" or "—".

## Write `.groundwork/outputs/survey.md`

The payoff of the survey: one page the person reads first, about what they did not already know. The map holds the details; this page holds the conclusions. Keep it under a page.

```md
---
written: 2026-10-08
---
# State of <project name>

One or two sentences: what the project is and where it stands.

## What is built
Two to four lines: the main screens or features, how many stories are done or partial, and how far along it looks.

## What I found
Three to seven things worth knowing that the person may have missed or forgotten, most important first. Each is one or two plain sentences with the node id it rests on, like (n_bz8p):
- docs and code that disagree
- decisions that quietly drifted from what was written down
- half built parts, TODOs and dead ends
- screens or features no doc or story explains
- risks for the next step, for example missing tests around the core flow

Not a list of what exists: only what is surprising, contradictory or risky.

## Design foundation
The scorecard in one line per app, and the weakest point.

## The three things worth doing next
1. Each one concrete and small enough to start today, with why it matters, and the node id when there is one.
```

On a re-run, rewrite it from the current state and drop findings that were answered.

## Report back

Short and plain, findings first:
- What I found: the top three findings, one line each.
- What the project is, in one line.
- How many thoughts you wrote on each page: settled, open, and guesses (`source: inferred`).
- How many stories, and how many are done or partial.
- The design scorecard in one line, for example "Design: 4 of 9 in place (colors and components found; no type scale, spacing scale or design docs)". With more than one app, one line per app plus the shared check, for example "iOS 6 of 9, Android 4 of 9, shared: partly".
- What you left out, if anything.
- The two or three questions that matter most.
- Say that Focus in the map (the top icon in the rail) goes through the questions and guesses one at a time, with options to pick from.
- That the whole summary is under Deliverables, State of the project.
- Suggest running `/readiness` next, to see what is missing for the next step.
