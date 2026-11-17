---
id: n_gbie6k
type: feature
title: Comment on a running Android app, as on iOS
topic: comments
page: Feedback
altitude: 3
links: [n_lk8q2v, n_0fe7zi]
status: open
created: 2026-11-17
built: 2026-11-17
---
The same package as GrndwrkFeedback for iOS, for Android: a floating grndwrk button in debug builds, pick an element and comment with a picture, pairing on the Wi-Fi with signed requests, comments kept on the phone until sent, the comments list, testing fixes with Approve and Reject, pictures of each screen for the Sitemap, the relay with invites and QR codes, the team's store, and speaking a comment.

Decided 2026-11-17:
- Everything the iOS package does, not a smaller first version.
- An app adds it from GitHub through JitPack, as `debugImplementation`, like the iOS package comes from GitHub.
- Elements are read through Android's accessibility tree, so it works for Jetpack Compose and Views alike.
- Tried first in the Android emulator, which reaches the Mac at 10.0.2.2, then in a real app.
