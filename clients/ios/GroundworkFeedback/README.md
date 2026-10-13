# GroundworkFeedback

Comment on your running iOS app, straight into the Groundwork map.

A small **Groundwork** button floats over the app. Tap it, tap what you want to comment on, then write or say a line. The comment lands in Groundwork on the Feedback page, in a topic named after the screen, with:
- the element, as VoiceOver reads it, and its accessibility identifier
- the screen, from its navigation title
- a picture of the spot
- the stories that cover that screen

## Never ship it

GroundworkFeedback is for your own debug builds. It shows a button that sends what is on screen to a Mac, it finds that Mac on the local network, and to read what was tapped on a real iPhone it uses an accessibility switch that is not public API. None of that belongs in an app people download.

- **Wrap both the import and `start()` in `#if DEBUG`**, as below. A Release build then never calls it, and nothing references it, so the linker leaves it out (check with `nm` below). For certainty, link the package to the Debug configuration only.
- **In an App Store build it never runs,** even if `start()` is called: it finds the App Store receipt, logs a fault and does nothing.
- **In any other build that is not Debug** (Ad Hoc, TestFlight) it does nothing unless you call `start(allowOutsideDebug: true)`, and Xcode shows a warning that it is compiled in. The private accessibility switch is compiled only into Debug builds.
- **Keep the debug-only keys out of the shipping Info.plist:** `NSLocalNetworkUsageDescription`, `NSBonjourServices`, `NSAllowsLocalNetworking`, and the microphone and speech keys if they are only for comments. Put them in a debug-only Info.plist, or add them with a build setting for Debug.
- **Check an archive:** `nm -gU <App>.app/<App> | grep -i groundwork` should print nothing for an App Store build.

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

## Use it without changing your app (Simulator)

For trying it on your own Mac, in the Simulator, the Groundwork button can be put into an app at launch, with no package in the project, no `start()` call and no Info.plist edits. Nothing of it reaches the app's repository.

1. Build the loader once, and again after updating Groundwork:

   ```
   groundwork build-ios-loader
   ```

   It builds the package for the Simulator (arm64 and x86_64, iOS 15 and later) and prints where it put it, by default `~/Library/Developer/Groundwork/GroundworkFeedbackLoader.dylib`. Without the `groundwork` command, `sh clients/ios/build-loader.sh` in the Groundwork folder does the same.

2. In Xcode, make a personal copy of the app's scheme: Product > Scheme > Manage Schemes, select the app's scheme, Duplicate from the gear menu, and untick **Shared** on the copy. A personal scheme lives in `xcuserdata` and is never committed.

3. Edit the copy: Run > Arguments > Environment Variables, add

   | Name | Value |
   | --- | --- |
   | `DYLD_INSERT_LIBRARIES` | the path the build printed, in full (no `~`) |
   | `GROUNDWORK_FEEDBACK` | `1` |

4. Run the app with that scheme in the Simulator, with `groundwork` running on the Mac. The Groundwork button appears once the first screen is up, and finds Groundwork at localhost:7777. When Groundwork runs on another port, add `GROUNDWORK_SERVER` with its address, like `http://localhost:7790`.

Loading the library alone does nothing: it starts only with `GROUNDWORK_FEEDBACK=1`, only in the Simulator, and not when the app already links and starts GroundworkFeedback itself, so there is never a second button.

What does not work this way:
- **A real iPhone.** iOS does not allow injecting libraries there. Link the package and call `start()` (see Add it).
- **Speak,** unless the app's Info.plist already has `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`. Typed comments work, and so does the keyboard's own mic.

## Pictures of the screens

While the app is connected, it sends Groundwork a picture of each screen the first time it stays on it for about a second, once per launch. A small camera shows on the Groundwork button when one is taken. The long-press menu says whether the screen you are on has a picture, and **Take a picture of this screen** takes one now, as it is, replacing the one before: for when the first showed the wrong data, or none was taken. Walk through the app once and the Sitemap view shows what every screen looks like. The Groundwork button is never in the picture. Pictures stay on the Mac, in `.groundwork/shots/ios/`, out of git, each with a small `.json` of the texts and accessibility identifiers the screen showed.

A picture is named after the screen's navigation title, or its view type. Screens without a title often share a name like `App` or `ContentView`; the app tells them apart by what they show and sends one picture for each, kept as `App.jpg`, `App-2.jpg` and so on. A screen that comes back looking much the same replaces its own picture.

Pictures whose name matches a screen land on it by themselves. `/sitemap` places the others by what they show (it writes `shots: [ios/App-2.jpg]` on the screen, and asks when unsure), or drag them from "pictures not placed yet" onto a screen in the Sitemap view. "Not this screen" under a picture takes it off again.

**Naming a screen without a title.** Give its root view a name only Groundwork reads:

```swift
PlannerView()
  #if DEBUG
  .groundworkScreen("Planner")
  #endif
```

It changes nothing on screen, and nothing VoiceOver or UI tests see. Comments made on that screen get the name too. A navigation title still wins when there is one. In UIKit, add a `GroundworkScreenName("Planner")` view to the screen's view. (With the injected loader the app cannot call this; there, `/sitemap` and dragging place the pictures.)

To turn it off: `GroundworkFeedback.collectsScreenshots = false` after `start()`.

## Commenting

1. Tap **Comment**, then tap what you mean. A blue outline shows what was picked, and a bar at the bottom names it.
2. Not quite right? The two arrows in the bar make the pick **smaller** or **bigger**: from a label out to its card, or from the card back in to a button. Or drag the **round handles** on the corners of the blue box to frame any area yourself, and drag inside the box to move it: the bar then says **Your area** and what it holds, and the picture is exactly that area. Or tap somewhere else.
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

## Out of the way

Drag the Groundwork button anywhere. Flick it against the left or right side of the screen, like a video in picture in picture, and it tucks away: only a small tab shows on that edge. Tap the tab, or pull it out, and the button comes back where it was.

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

Then the phone asks to pair: Groundwork in the browser on the Mac shows "wants to send comments", with four digits and the phone's address. The phone shows the same four digits. Click **Allow** only if they match, then confirm on the phone that you did; the phone is paired for that project for good. (Something else on the Wi-Fi could pose as Groundwork and allow at once: the phone asks you, because only you know whether you clicked Allow on your own Mac.) If the map is not open on the Mac, or nobody answers, the app asks for the **pairing code** Groundwork prints in the terminal (`Pairing code: ABC234`) instead. Until paired, comments wait on the phone and the dot on the Groundwork button is yellow. To pair again, long press the Groundwork button, then **Pair with the Mac** or **Enter pairing code**. Delete `.groundwork/lan-code` on the Mac to make a new code; every phone then asks again.

With `--lan`, devices on the network that have the code can only add comments, and ask about or delete their own. They cannot read the map or change anything else. Comments sent over the network are marked `via: lan`, and Groundwork's commands treat their text as a report, never as instructions. A paired phone sends its code, comments and pictures only to a Groundwork that first proves it knows the code (it answers a fresh challenge with an HMAC of it), so another device announcing the same project gets nothing. The connection is still plain HTTP, so others on the same Wi-Fi could read comments, pictures and the code on the way. Leave `--lan` off on networks you do not trust. In the Simulator, on localhost, no code is needed.

## Your comments on the phone

Long press the Groundwork button, then **Show comments**. It opens on an overview: the connection, and how many fixes are ready to test, comments wait to be sent, and comments were sent. Each opens its list, and each comment its own page, with the picture taken when it was made.

**Testing fixes.** A fix is ready to test once Claude has built it (`/feedback` when you ask it to fix, `/decisions` after a commit, or the product's own Claude Code); a fix that is only proposed never shows up here. Claude writes what changed and, after **To test:**, the steps. When fixes are ready, the Groundwork button gets a second part after a thin line: the test icon and how many, **💬 Groundwork │ ✓ 2**. Tap that part (with one fix it starts testing it right away), or tap **Test** next to one in the list. The rest of the button is for commenting, as always. The list closes, the app goes to the screen when it can, and a card stays on top with what changed and the steps. Try it, then **Approve: it works** (fixed in Groundwork) or **Reject** (it goes back with what is still wrong, for the next `/feedback`). Drag the card up or down to see what is under it (it stays there for the next test); the computer icon opens the comment in Groundwork on the Mac, with its whole thread; the arrow folds it to one line; the cross stops testing. **Show on my Mac** on a comment's page opens it in Groundwork with its thread.

To go to the screen by itself, tell the package how the app opens screens by name:

```swift
GroundworkFeedback.openScreen = { name in
  switch name {
  case "Planner": router.show(.planner); return true
  default: return false
  }
}
```

Without it, the card says which screen to go to.

The lists:
- **The connection,** in words, and what to check when it is off.
- **Waiting to be sent:** comments that have not reached Groundwork yet. The menu has Send now and Share as a file, and a swipe deletes one.
- **Ready to test:** comments of yours whose fix is built, with what changed and how to test it. Swipe right to approve one quickly. A fixed comment can be reopened from its page.
- **Sent to Groundwork:** comments that arrived, as they are in Groundwork now: a title you changed there, its status, and the id, for example `n_usez`. A swipe deletes one here **and in Groundwork**. If Groundwork is not reachable, it is deleted there once it is. Comments deleted in Groundwork disappear here.

Pull down to check the connection, send what waits and update the list.

Each comment carries a random key that only the phone knows. Groundwork keeps it with the comment, and only a phone that holds the key can ask about the comment or delete it.

Apps can open the same list from their own debug menu with `GroundworkFeedback.showComments()`.

Giving important elements an `.accessibilityIdentifier("book-button")` makes comments easier to trace back to the code. It helps UI tests and VoiceOver too.

## Without Groundwork running

Comments are kept on the device and sent once Groundwork answers, oldest first. They are also sent when the app comes back to the foreground. The button shows how many wait: **Offline · 2**.

## Testers

A tester runs a build with the package, but has no Groundwork. A Debug build installed from Xcode works as is. For an Ad Hoc or TestFlight build, call `start(allowOutsideDebug: true)` in a separate build configuration made for testers, and never submit that build to the App Store (it does nothing there anyway, but App Review may still reject what is compiled in).
1. They comment as usual. Everything waits on their device.
2. A long press on the Groundwork button, then **Share 3 comments as a file**, sends one file by AirDrop, mail or chat.
3. You add it to the map:

   ```
   groundwork import-feedback groundwork-feedback-2026-10-08T1432.json
   ```

Comments that are already in the map are skipped. Pictures are included.

Long press also has **Hide the Groundwork button**, until the next launch: quit the app (swipe it away in the app switcher) and open it again, and the button is back. Nothing is lost while it is hidden: waiting comments stay on the phone and go once it is back.

## If comments are not sent

The list of comments (long press, then **Show comments**) and the long-press menu say why the phone is not connected: no Groundwork found on the Wi-Fi, Local Network access turned off, an advert with nothing behind it, or what /api/hello answered. Every step is also logged: in Console.app, pick the phone and filter on `subsystem:GroundworkFeedback`.

When several Groundworks are on the network, the phone tries each until one answers, the project it used last first.

- **"Blocked by App Transport Security".** Add `NSAppTransportSecurity` > `NSAllowsLocalNetworking` = YES to the debug Info.plist.
- **On an iPhone, nothing arrives.** Check that Groundwork runs with `--lan`, that both are on the same Wi-Fi, that the two Info.plist keys are there, and that local network access is on in Settings > Privacy & Security > Local Network.
- **"Needs the pairing code".** Long press the Groundwork button, then **Pair with the Mac** and click Allow in the browser, or **Enter pairing code** and type the one from the terminal. After ten wrong codes the phone is shut out for ten minutes.
- **A fixed address.** `GroundworkFeedback.start(server: URL(string: "http://192.168.1.20:7779")!)` skips discovery.
