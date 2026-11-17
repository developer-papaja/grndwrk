---
id: n_ph5kq2
type: decision
title: The iOS and Android packages stay the same, and are tested the same way
topic: comments
page: Feedback
altitude: 4
links: [n_gbie6k]
status: principle
created: 2026-11-17
---
Commenting from a phone is one feature, built twice: GrndwrkFeedback for iOS (Swift) and for Android (Kotlin). Someone testing on an iPhone and a colleague on Android should see the same button, the same words and the same steps, and grndwrk should get the same requests from both.

So a change to one package goes into the other in the same piece of work: a behavior, the wording of a message, a field in a request, a check on what comes back. When a platform cannot do something, the package's README says so. grndwrk's server code is the reference for requests, keys and lines, not the other package.

Both are tested with the same steps, on the Simulator and the emulator against a test map of their own, then on real phones: `clients/TESTING.md` in the repository.
