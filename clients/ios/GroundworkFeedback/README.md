# GroundworkFeedback

Comment on your running iOS app, straight into the Groundwork map.

A small **Comment** button floats over the app. Tap it, tap what you want to comment on, then write or say a line. The comment lands in Groundwork on the Feedback page, in a topic named after the screen, with:
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

## Commenting

1. Tap **Comment**, then tap what you mean. A blue outline shows what was picked, and a bar at the bottom names it.
2. Not quite right? The two arrows in the bar make the pick **smaller** or **bigger**: from a label out to its card, or from the card back in to a button. Or tap somewhere else.
3. Tap **Comment** in the bar. A sheet opens with a picture of the spot:
   - type, or tap **Speak** and say it. The language button next to it picks which language to listen for.
   - or tap **Write on the Mac**: the comment opens in Groundwork in the browser, with its title ready to type over. Handy when you sit at the Mac anyway.

Speaking needs two more keys in the debug Info.plist (without them the Speak button says what to add, and the keyboard's own mic still works):

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Speak comments for Groundwork.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Turn spoken comments into text for Groundwork.</string>
```

Recognition runs on the phone when it can.

**Finding elements on a real iPhone.** iOS only builds the list of elements VoiceOver reads while something asks for it. When the package finds none, it asks iOS to build it, the way UI test tools do, and turns that off again when the app leaves the front.

## Connected or not

The dot on the button is **green** when Groundwork answers, **orange** when it does not. When it does not, the button says **Offline · 2**, with how many comments wait. A short message says when Groundwork is found or lost.

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
- **The connection,** in words, and what to check when it is off.
- **Waiting to be sent:** comments that have not reached Groundwork yet. The menu has Send now and Share as a file, and a swipe deletes one.
- **Sent to Groundwork:** comments that arrived, as they are in Groundwork now: a title you changed there, its status, and the id, for example `n_usez`. A swipe deletes one here **and in Groundwork**. If Groundwork is not reachable, it is deleted there once it is. Comments deleted in Groundwork disappear here.

Pull down to check the connection, send what waits and update the list.

Each comment carries a random key that only the phone knows. Groundwork keeps it with the comment, and only a phone that holds the key can ask about the comment or delete it.

Apps can open the same list from their own debug menu with `GroundworkFeedback.showComments()`.

Giving important elements an `.accessibilityIdentifier("book-button")` makes comments easier to trace back to the code. It helps UI tests and VoiceOver too.

## Without Groundwork running

Comments are kept on the device and sent once Groundwork answers, oldest first. They are also sent when the app comes back to the foreground. The button shows how many wait: **Offline · 2**.

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
