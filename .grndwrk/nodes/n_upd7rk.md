---
id: n_upd7rk
type: feature
title: Say when grndwrk or the project's agent rules are out of date
topic: setup
altitude: 2
links: [n_uvdxr1]
status: settled
created: 2026-11-18
built: 2026-11-18
by: Måns Brengesjö
summary: "Built: start, Status and grndwrk check say when the rules are behind or a newer grndwrk is out. Your look is left."
---
The rules and commands an agent follows are copies init put in the project, so after updating grndwrk an agent keeps working by the old ones until init runs again (an agent wrote a new test list instead of marking the steps, by rules from before). Say it where both the person and the agent see it, and say when a newer grndwrk is on npm, with a way to turn that check off.