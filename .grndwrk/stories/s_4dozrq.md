---
id: s_4dozrq
title: Let colleagues comment from a staging site, through the relay
status: done
from: [n_go8wdt]
applies_to: ["overlay/relay.js", "relay/src/relay.ts", "src/relay/cli.ts", "src/relay/sync.ts"]
created: 2026-11-16
---
As someone with a staging site, I want colleagues to comment there as they would on my machine,
so that people who never run the project can still say what is wrong.

## Acceptance
- [x] `grndwrk relay site <origin>` names one staging site and prints the line for its layout
- [x] The relay serves the button only to that site, and it runs only there
- [x] A browser joins with an invite, shows four digits and waits to be allowed, like a phone
- [x] Fixes made for its comments are tested there, as on the local site
