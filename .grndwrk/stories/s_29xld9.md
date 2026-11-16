---
id: s_29xld9
title: Let colleagues away from my Wi-Fi comment, through the team's relay
status: partial
from: [n_0fe7zi, n_ddomtg, n_cicqhb, n_raqz00, n_0ryo1l, n_hihlky]
applies_to: ["relay/src/relay.ts", "src/relay/sync.ts", "src/relay/cli.ts", "src/relay/keys.ts", "clients/ios/GrndwrkFeedback/Sources/GrndwrkFeedback/Relay.swift", "clients/ios/GrndwrkFeedback/Sources/GrndwrkFeedback/Join.swift"]
created: 2026-11-16
---
As someone whose colleagues test on TestFlight, I want them to send comments from anywhere,
so that their feedback reaches the map without them being on my network.

## Acceptance
- [x] `grndwrk relay deploy` puts a relay on the team's own Cloudflare account; it holds only sealed envelopes
- [x] An invite by name gives a link and a QR code; the phone joins and waits until allowed in the map with four digits
- [x] Comments arrive with the colleague's name, and what became of them goes back to their phone
- [x] A colleague can be removed in the map, and the relay then refuses their phone
- [ ] A teammate who runs grndwrk and leaves the team can be taken out (a new team key for the rest)
- [ ] Two teammates fetching at the same moment never both take the same comment
