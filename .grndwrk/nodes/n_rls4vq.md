---
id: n_rls4vq
type: feature
title: See which release a story or thought shipped in
topic: stories
page: Product
altitude: 3
links: []
status: settled
created: 2026-11-18
by: Måns Brengesjö
built: 2026-11-18
summary: "Built: releases fit versions, deploys or not yet, recommended by the agent; try /release in a deploy project."
---
Agents already write "Released in 0.4.0" into a thread now and then, but nothing ties a story or a thought to a release, so later there is no way to see what went out when. Track it afterwards first; planning a release ahead can come later on the same files.

It should fit many kinds of projects: an npm package with versions, an app with App Store builds, a web product deployed every day, a team working in sprints. So a release is a name and a date, nothing more required: "0.4.3", "2.1 (45) on TestFlight", "Sprint 12", "Deployed 2026-11-18".

A sketch:
- A release is a file of its own, `releases/<id>.md`: its name, its date, optionally where it went (npm, App Store, staging), and notes. One file per release, so two people's releases never conflict.
- The release file lists what shipped in it, by id. Stories and thoughts are not changed, so nothing in them conflicts either.
- A story or thought shows "Released in 0.4.3 · 2026-11-18" in its panel; Deliverables can group or filter stories by release, and list the releases with what each held.
- Later, planning: the same file without a date, marked planned.