---
id: s_c3ahz5
title: Comment on my running website, and the comment lands on the map
status: done
from: [n_ju3hnw, n_9dk905, n_pf4w7x]
applies_to: ["overlay/feedback.js", "src/server/proxy.ts", "src/server/feedback.ts", "src/server/sites.ts"]
created: 2026-11-16
---
As a developer trying my own product, I want to point at something on a page and say what is wrong,
so that it reaches the map with where it was, without copying screenshots around.

## Acceptance
- [x] With `--app`, the product opens behind a proxy with a Comment button on every page
- [x] A line in the product's layout loads the button on its own address, for local development only
- [x] A click picks an element; Smaller, Bigger and corner handles frame what the comment is about
- [x] The comment becomes a thought on the Feedback page, in a topic named after the screen, with a picture of the spot
- [x] A site's first comment asks in the map before anything from it is taken
- [x] The button floats, docks as a bar at the bottom, or folds into a tab, and its menu says where comments go
