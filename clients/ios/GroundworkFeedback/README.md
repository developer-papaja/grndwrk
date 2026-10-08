# GroundworkFeedback

Comment on your running iOS app, straight into the Groundwork map.

A small **Comment** button floats over the app. Tap it, tap what you want to comment on, write a line. The comment lands in Groundwork on the Feedback page, in a topic named after the screen, with:
- the element, as VoiceOver reads it, and its accessibility identifier
- the screen, from its navigation title
- a picture of the spot
- the stories that cover that screen

## Add it

1. In Xcode: File > Add Package Dependencies > Add Local, and pick `clients/ios/GroundworkFeedback` in the Groundwork folder.
2. Start it in debug builds only:

   ```swift
   #if DEBUG
   import GroundworkFeedback
   #endif

   @main struct MyApp: App {
     init() {
       #if DEBUG
       GroundworkFeedback.start()
       #endif
     }
     var body: some Scene { WindowGroup { ContentView() } }
   }
   ```

3. Run `groundwork` in the project, and run the app in the Simulator. The Simulator reaches your Mac as `localhost:7777`.

Giving important elements an `.accessibilityIdentifier("book-button")` makes comments easier to trace back to the code. It helps UI tests and VoiceOver too.

## Without Groundwork running

Comments are kept on the device and sent once Groundwork answers, oldest first. The button shows how many wait: **Comment · 2**.

## Testers

A tester runs a debug or TestFlight build with the package, but has no Groundwork:
1. They comment as usual. Everything waits on their device.
2. A long press on the Comment button, then **Share 3 comments as a file**, sends one file by AirDrop, mail or chat.
3. You add it to the map:

   ```
   groundwork import-feedback groundwork-feedback-2026-10-08T1432.json
   ```

Comments that are already in the map are skipped. Pictures are included.

Long press also has **Hide the Comment button**, until the next launch.

## If comments are not sent

- **"Blocked by App Transport Security".** Add `NSAppTransportSecurity` > `NSAllowsLocalNetworking` = YES to the debug Info.plist.
- **Another address.** Groundwork listens on this Mac only. On another port, use `GroundworkFeedback.start(server: URL(string: "http://localhost:7778")!)`.
