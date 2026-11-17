# Testing the phone packages

GrndwrkFeedback exists twice: for iOS in `clients/ios/GrndwrkFeedback` (Swift) and for Android in `clients/android/feedback` (Kotlin). They are one feature in two languages and must behave the same: the same features, the same words on screen, the same requests to grndwrk, the same security checks. This file is how to check both. Run the same steps on both whenever either changes.

## Keeping them the same

- A change to one package is made in the other in the same piece of work: a behavior, a message's wording, a field in a request, a check on what comes back. When it cannot be (a platform has no such thing), say so in the commit and in the package's README, as the Android README does for the loader.
- Requests, keys and lines are grndwrk's: `src/server/devices.ts` and `src/server/pairing.ts` (signing, pairing), `src/relay/keys.ts` (relay keys and sealing), `src/shared-store/http.ts` (the store). Both packages follow them byte for byte; the server is the reference, not the other package.
- File for file, they line up: `Locator`, `Connection` (with `Pairing`), `Outbox`, `Relay`, `Store`, `Join`, `Inspector`, `Snapshots`, `ScreenName`, `Dictation`, `Distribution`, and the UI (`Overlay`, `Compose` / `ComposeSheet`, `CommentsList`). Look in the same file on the other side.
- The two READMEs have the same sections in the same order. A section added to one is added to the other.

## Automated

| | iOS | Android |
| --- | --- | --- |
| Build | `xcodebuild -scheme GrndwrkFeedback -destination 'generic/platform=iOS Simulator' build` from the repository root (uses the root `Package.swift`) | `./gradlew :feedback:assembleDebug :sample:assembleDebug` in `clients/android` |
| Unit tests | none yet | `./gradlew :feedback:testDebugUnitTest` in `clients/android`: keys, sealing, signing, pairing digits and links, checked against values from grndwrk's TypeScript |
| Server side | `npm test` (`test/shots.test.ts`, the comment, pairing, relay and store tests) | the same |

Neither package is built in CI yet.

## A test map of its own

Never test against a map you use. Start a throwaway one, with its per-user files kept apart too:

```
mkdir -p /tmp/gw-phone/map /tmp/gw-phone/state && cd /tmp/gw-phone/map && git init -q
export GRNDWRK_PORTS_FILE=/tmp/gw-phone/state/ports.json GRNDWRK_SITES_FILE=/tmp/gw-phone/state/sites.json GRNDWRK_RELAY_DIR=/tmp/gw-phone/state/relay GRNDWRK_WAITING_FILE=/tmp/gw-phone/state/waiting.json
grndwrk init </dev/null
grndwrk --port 7790 --no-open --lan
```

The map is at `http://localhost:7790`, the phone listener at port 7792 with the pairing code it prints.

- **iOS Simulator:** the sample is any app with the package; start it with `GrndwrkFeedback.start(server: URL(string: "http://localhost:7790"))`, or the loader with `GRNDWRK_SERVER=http://localhost:7790`.
- **Android emulator:** `./gradlew :sample:installDebug -PgrndwrkServer=http://10.0.2.2:7790` in `clients/android`, then open Vet Clinic.

## The same steps on both

Do each on the Simulator and on the emulator. What should happen is the same on both.

1. **Connect.** The button reads grndwrk with a green dot.
2. **Screen pictures.** A small camera blinks once per screen. The Sitemap's "not placed yet" shows them; `.grndwrk/shots/ios/` and `shots/android/` hold each with a `.json` of the texts and ids, never what a text field holds.
3. **Comment.** Tap grndwrk, tap an element, try Smaller and Bigger, drag a corner handle for Your area, then Comment, write a line, Send. A card lands on the Feedback page with the element, the screen and a picture of the spot, without the button in it and with text fields drawn empty.
4. **Write on the Mac.** The comment opens in the map with its title selected.
5. **Speak** (a device, or a Simulator or emulator with a microphone): Speak fills the field; the language button changes the language.
6. **Offline.** Stop the test map, comment, start it again: the comment goes by itself. Long press, Show comments, Save waiting comments as a file, then `grndwrk import-feedback <file>` adds it.
7. **Test a fix.** In the test map, add `proposed:` and `built:` to the card and a `**Claude**` entry in its thread with `To test:` and numbered steps (or run `/feedback` and build it). End one step with `[automated: SomeTest.name]`, one with `[agent: checked in the emulator]` and one with `[outdated: the tab is gone]`. Relaunch the app: the button gets a second part with the test icon and 1. Tap it: the card shows what changed and the steps with Works and No; each marked step has an icon in a column of its own before Works, lined up with the others, and tapping it spells out the check under the step. Mark a step No and Reject with a note: the map gets "Tested on the phone: rejected" with the note quoted, and the card is incoming again. Repeat and Approve: the card is fixed.
8. **The list.** Long press, Show comments: connection, Ready to test, Waiting, Sent; a comment's page with its picture, Show on my Mac, Delete (deleted in the map too).
9. **Pair over the network.** Point the app at the phone listener (`http://localhost:7792` in the Simulator, `http://10.0.2.2:7792` in the emulator). The dot turns yellow; long press, Enter pairing code, type the code: connected, and `.grndwrk/lan-devices.json` lists the device. Also try Pair with the Mac: the map shows four digits, the phone the same four; Allow.
10. **The relay and the store** (needs a relay or a store of your own, see the main README): Join with a store link or invite, by pasting and by QR code. Comments go through, Show on my Mac is not offered, and the status of a comment comes back.
11. **Release builds.** iOS: an Archive's binary has no grndwrk symbols (`nm`, see the iOS README). Android: `./gradlew :sample:assembleRelease` holds no `grndwrk.feedback` classes (`apkanalyzer dex packages`), and a debuggable build installed by Google Play would refuse to start.

## On real phones

Run grndwrk with `--lan` on the Mac and put the phone on the same Wi-Fi. Without a fixed server address, the package finds grndwrk by itself (Bonjour on iOS, NSD on Android) and asks to be paired. Do steps 1 to 9 there too, without pointing at a server. The Android emulator cannot find the Mac this way (it sits behind its own network), so finding grndwrk on the Wi-Fi is tested on a real Android phone only.
