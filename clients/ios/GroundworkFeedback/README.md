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

## On your iPhone, over Wi-Fi

Start Groundwork with `groundwork --lan`. The app finds your Mac by itself on the same Wi-Fi, so there is no address to type. Two keys in the app's debug Info.plist let iOS allow that:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Send comments to Groundwork on your Mac.</string>
<key>NSBonjourServices</key>
<array><string>_groundwork._tcp</string></array>
```

The first time, iOS asks whether the app may find devices on the local network. Answer yes.

With `--lan`, other devices on the network can only add comments. They cannot read the map or change anything else. Leave it off on networks you do not trust.

## Your comments on the phone

Long press the Comment button, then **Show comments**:
- **Waiting to be sent:** comments that have not reached Groundwork yet. The menu has Send now and Share as a file, and a swipe deletes one.
- **Sent to Groundwork:** comments that arrived, with the id they got in the map, for example `n_usez`.

Apps can open the same list from their own debug menu with `GroundworkFeedback.showComments()`.

Giving important elements an `.accessibilityIdentifier("book-button")` makes comments easier to trace back to the code. It helps UI tests and VoiceOver too.

## Without Groundwork running

Comments are kept on the device and sent once Groundwork answers, oldest first. They are also sent when the app comes back to the foreground. The button shows how many wait: **Comment · 2**.

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
- **On an iPhone, nothing arrives.** Check that Groundwork runs with `--lan`, that both are on the same Wi-Fi, that the two Info.plist keys are there, and that local network access is on in Settings > Privacy & Security > Local Network.
- **A fixed address.** `GroundworkFeedback.start(server: URL(string: "http://192.168.1.20:7779")!)` skips discovery.
