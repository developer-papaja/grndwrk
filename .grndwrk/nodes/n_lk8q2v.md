---
id: n_lk8q2v
type: decision
title: Each paired phone gets its own key, and signs every request with it
topic: comments
topic_by: claude
page: Feedback
altitude: 2
links: []
status: settled
created: 2026-11-03
---
From the security audit of 2026-11-03: anyone on the Wi-Fi could recover the six-character pairing code offline from one hello answer, and a fake grndwrk could relay a phone's hello to get its code. Chosen over a long secret alone or leaving --lan for trusted networks only. Pairing (Allow in the map, or the code typed once) now gives the phone a long random key; the hello proof uses it, and requests are signed instead of carrying it. Phones paired before pair once more.

Done 2026-11-03, not committed yet: `src/server/devices.ts`, `src/server/lan.ts`, `src/server/pairing.ts`, `clients/ios/GrndwrkFeedback/Sources/GrndwrkFeedback/Connection.swift`.
