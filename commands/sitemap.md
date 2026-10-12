---
description: Write the product's site map from its code: every screen, what it is for, who it is for, and what the person is expected to do there
---
Read this product's code and write its site map into Groundwork: one file per screen, page or view, saying what it is for, who it is meant for, and what the person is expected to do there. You only read the project; you write inside `.groundwork/screens/`, and add `screen:` to thoughts in `.groundwork/nodes/`.

The rule above all: **code shows what a screen contains, rarely why it exists or who it is for.** Say what the code shows. Where purpose or audience is your guess, mark it as a guess and ask.

`$ARGUMENTS` may name one screen (an id or a title). Then update only that screen and the screens directly under it, and add screens for parts of it the code has that the sitemap lacks. Leave the rest alone.

## Read

1. **Screens and how they connect.**
   - **iOS:** the app entry (`@main`), `TabView` tabs, `NavigationStack` and `NavigationLink` destinations, `.sheet` and `.fullScreenCover`, `navigationDestination`, and in UIKit the view controllers, storyboards and segues. In an Xcode project, read the folders and Swift files directly; the `.xcodeproj` file only lists them.
   - **Web:** the router (React Router, Next.js `app/` or `pages/`, SvelteKit, Vue Router, server routes that render pages), and the links and redirects between pages.
   - **Other:** whatever decides what the person sees next.
2. **What each screen asks of the person:** its buttons, forms, lists and empty states. That is what they are expected to do there.
3. **`.groundwork/`:** `project.md` (purpose and who the product is for), the nodes (look for `type: audience` and `flow`), the stories (`applies_to` says which code they cover), and the existing `screens/`. If screens exist, update them; never duplicate them.
4. **Docs:** README, CLAUDE.md, a `docs/` folder, for what screens are for.

A screen is something the person navigates to: a tab, a pushed view, a page, a sheet or modal with a task of its own. Alerts, menus, loading states and small pickers are not screens; mention them in the notes of the screen they belong to.

## Write one file per screen, `.groundwork/screens/<id>.md`

```md
---
id: p_k2m4
title: Booking
parent: p_home
purpose: Book a desk for one day, in as few steps as possible.
for: [someone arriving at the office]
does:
  - pick a day
  - pick a desk on the floor plan
  - confirm the booking
leads_to: [p_conf, p_desk]
code: [/booking, App/Booking/BookingView.swift]
stories: [s_k3f9]
status: built
source: code
created: 2026-10-12
---
One or two lines on what is on the screen, and anything half built.
```

- `id`: `p_` plus four random lowercase letters or digits that do not exist yet. Never change the id of a screen that exists; other files point at it.
- `title`: the name a person would use for it, as the app shows it when it has one ("Booking", "Settings"). Not a type name like BookingView.
- `parent`: the screen it sits under: the tab or page it is opened from. Top level screens (tabs, the start page) have none. The tree should read like the app's navigation.
- `purpose`: one plain sentence, what the screen is for from the person's side, not what the code does.
- `for`: who it is meant for, in the product's own words for its people (reuse the audience nodes and `project.md`). Several when it serves several. Empty when nothing says.
- `does`: what the person is expected to do there, as short verb phrases, most important first. Two to five.
- `leads_to`: the screens reached from here, by id.
- `code`: the route (for the web) and the main source files. These connect the screen to stories and to comments made on it in the running product, so use the type and file names the code really has.
- `stories`: ids of stories that cover the screen, when their `applies_to` or their text points at it.
- `status`: `built`, `partial` (started, TODOs, dead ends, placeholder text) or `planned` (a story or the brief needs it, but no code has it yet).
- `source`: `code` when the code shows what the screen is for, `inferred` when purpose or audience is your guess.

**When purpose or audience is a guess,** write your best guess, set `source: inferred`, and ask in a thread at the end of the notes, with options to pick from:

```md
## Thread

**Claude asks** · 2026-10-12
Is Insights meant for the person who trains, or for a coach looking at their progress?

Options:
- The person who trains
- A coach
- Both
```

Ask at most five questions in the whole run, about the screens that matter most. A question stays open until any entry follows it.

**On a re-run,** keep ids, `created` and anything the person wrote: purpose, `for`, `does` and answers in the thread are theirs. Update `code`, `leads_to`, `stories` and `status` from the code. When the code no longer has a screen, set `status: partial` and say so in the notes instead of deleting the file; ask in its thread whether to remove it.

## File the thoughts under their screens

The map can show a column per screen, with General first for what is about the whole product. Go through every thought in `.groundwork/nodes/` that has no `screen:` yet, and decide where it belongs:

- **One screen:** the thought is clearly about that screen, its content, a feature on it or a detail of it ("The filter on the routes list", a comment about the Goals form). Add one line `screen: <id>` to its frontmatter, after `page:` (or after `topic:` when there is no page). Change nothing else in the file.
- **The whole product, or several screens:** the purpose, principles, the audience, the look and feel, technical decisions, flows that cross screens. Leave it without `screen:`; it shows under General.
- **Unsure between screens:** leave it without `screen:` and add a question to its thread with the screens as options:

  ```md
  **Claude asks** · 2026-10-12
  Which screen is this about?

  Options:
  - Goals
  - New goal
  - The whole product
  ```

Never change a `screen:` that is already set; the person or an earlier run chose it. Comments with `source: app` already belong to the screen they were made on through their topic; add `screen:` to them too when the screen exists.

Write plainly. Do not use the dash characters "–" or "—". Write only inside `.groundwork/screens/`, and in `.groundwork/nodes/` only the `screen:` line and thread questions.

## Report back

A short plain paragraph: how many screens, the top level of the tree in one line, which screens have no story and which stories have no screen, how many thoughts you filed under a screen and how many stay under General, and the questions you asked.
