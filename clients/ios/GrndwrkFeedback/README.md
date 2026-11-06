# GrndwrkFeedback

Comment on your running iOS app, straight into the grndwrk map.

A small **grndwrk** button floats over the app. Tap it, tap what you want to comment on, then write or say a line. The comment lands in grndwrk on the Feedback page, in a topic named after the screen, with:
- the element, as VoiceOver reads it, and its accessibility identifier
- the screen, from its navigation title
- a picture of the spot
- the stories that cover that screen

## Never ship it

GrndwrkFeedback is for your own debug builds. It shows a button that sends what is on screen to a Mac, it finds that Mac on the local network, and to read what was tapped on a real iPhone it uses an accessibility switch that is not public API. None of that belongs in an app people download.

- **Wrap both the import and `start()` in `#if DEBUG`**, as below. A Release build then never calls it, and nothing references it, so the linker leaves it out (check with `nm` below). For certainty, link the package to the Debug configuration only.
- **In an App Store build it never runs,** even if `start()` is called: it finds the App Store receipt, logs a fault and does nothing.
- **In any other build that is not Debug** (Ad Hoc, TestFlight) it does nothing unless you call `start(allowOutsideDebug: true)`, and Xcode shows a warning that it is compiled in. The private accessibility switch is compiled only into Debug builds.
- **Keep the debug-only keys out of the shipping Info.plist:** `NSLocalNetworkUsageDescription`, `NSBonjourServices`, `NSAllowsLocalNetworking`, and the microphone and speech keys if they are only for comments. Put them in a debug-only Info.plist, or add them with a build setting for Debug.
- **Check an archive:** `nm -gU <App>.app/<App> | grep -i grndwrk` should print nothing for an App Store build.

## Add it

1. In Xcode: File > Add Package Dependencies, paste `https://github.com/developer-papaja/grndwrk`, and pick **Up to Next Minor Version** from the version of grndwrk you run (`npm ls -g grndwrk`), so the phone and the map stay in step. Everyone on the team gets it from GitHub when they build, CI too; nothing is copied into the app's repository. Add the library to the app target only.

   Working on grndwrk itself? Drag your checkout's `clients/ios/GrndwrkFeedback` folder into the app's project navigator: Xcode then builds your local copy instead of the one from GitHub, and the project file does not change.
2. Start it in debug builds only:

   ```swift
   #if DEBUG
   import GrndwrkFeedback
   #endif

   @main struct MyApp: App {
     init() {
       #if DEBUG
       GrndwrkFeedback.start()
       #endif
     }
     var body: some Scene { WindowGroup { ContentView() } }
   }
   ```

3. Run `grndwrk` in the project, and run the app in the Simulator. The Simulator reaches your Mac as `localhost:7777`.

## Use it without changing your app (Simulator)

For trying it on your own Mac, in the Simulator, the grndwrk button can be put into an app at launch, with no package in the project, no `start()` call and no Info.plist edits. Nothing of it reaches the app's repository.

1. Build the loader once, and again after updating grndwrk:

   ```
   grndwrk build-ios-loader
   ```

   It builds the package for the Simulator (arm64 and x86_64, iOS 15 and later) and prints where it put it, by default `~/Library/Developer/grndwrk/GrndwrkFeedbackLoader.dylib`. Without the `grndwrk` command, `sh clients/ios/build-loader.sh` in the grndwrk folder does the same.

2. In Xcode, make a personal copy of the app's scheme: Product > Scheme > Manage Schemes, select the app's scheme, Duplicate from the gear menu, and untick **Shared** on the copy. A personal scheme lives in `xcuserdata` and is never committed.

3. Edit the copy: Run > Arguments > Environment Variables, add

   | Name | Value |
   | --- | --- |
   | `DYLD_INSERT_LIBRARIES` | the path the build printed, in full (no `~`) |
   | `GRNDWRK_FEEDBACK` | `1` |

4. Run the app with that scheme in the Simulator, with `grndwrk` running on the Mac. The grndwrk button appears once the first screen is up, and finds grndwrk at localhost:7777. When grndwrk runs on another port, add `GRNDWRK_SERVER` with its address, like `http://localhost:7790`.

Loading the library alone does nothing: it starts only with `GRNDWRK_FEEDBACK=1`, only in the Simulator, and not when the app already links and starts GrndwrkFeedback itself, so there is never a second button.

What does not work this way:
- **A real iPhone.** iOS does not allow injecting libraries there. Link the package and call `start()` (see Add it).
- **Speak,** unless the app's Info.plist already has `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`. Typed comments work, and so does the keyboard's own mic.

## Pictures of the screens

While the app is connected, it sends grndwrk a picture of each screen the first time it stays on it for about a second, once per launch. A small camera shows on the grndwrk button when one is taken. The long-press menu says whether the screen you are on has a picture, and **Take a picture of this screen** takes one now, as it is, replacing the one before: for when the first showed the wrong data, or none was taken. Walk through the app once and the Sitemap view shows what every screen looks like. The grndwrk button is never in the picture. Pictures stay on the Mac, in `.grndwrk/shots/ios/`, out of git, each with a small `.json` of the texts and accessibility identifiers the screen showed.

A picture is named after the screen's navigation title, or its view type. Screens without a title often share a name like `App` or `ContentView`; the app tells them apart by what they show and sends one picture for each, kept as `App.jpg`, `App-2.jpg` and so on. A screen that comes back looking much the same replaces its own picture.

Pictures whose name matches a screen land on it by themselves. `/sitemap` places the others by what they show (it writes `shots: [ios/App-2.jpg]` on the screen, and asks when unsure), or drag them from "pictures not placed yet" onto a screen in the Sitemap view. "Not this screen" under a picture takes it off again.

**Naming a screen without a title.** Give its root view a name only grndwrk reads:

```swift
PlannerView()
  #if DEBUG
  .grndwrkScreen("Planner")
  #endif
```

It changes nothing on screen, and nothing VoiceOver or UI tests see. Comments made on that screen get the name too. A navigation title still wins when there is one. In UIKit, add a `GrndwrkScreenName("Planner")` view to the screen's view. (With the injected loader the app cannot call this; there, `/sitemap` and dragging place the pictures.)

To turn it off: `GrndwrkFeedback.collectsScreenshots = false` after `start()`.

## Commenting

1. Tap **Comment**, then tap what you mean. A blue outline shows what was picked, and a bar at the bottom names it.
2. Not quite right? The two arrows in the bar make the pick **smaller** or **bigger**: from a label out to its card, or from the card back in to a button. Or drag the **round handles** on the corners of the blue box to frame any area yourself, and drag inside the box to move it: the bar then says **Your area** and what it holds, and the picture is exactly that area. Or tap somewhere else.
3. Tap **Comment** in the bar. A sheet opens with a picture of the spot:
   - type, or tap **Speak** and say it. The language button next to it picks which language to listen for.
   - or tap **Write on the Mac**: the comment opens in grndwrk in the browser, with its title ready to type over. Handy when you sit at the Mac anyway.

Speaking needs two more keys in the debug Info.plist (without them the Speak button says what to add, and the keyboard's own mic still works):

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Speak comments for grndwrk.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Turn spoken comments into text for grndwrk.</string>
```

Recognition runs on the phone when it can.

**Finding elements on a real iPhone.** iOS only builds the list of elements VoiceOver reads while something asks for it. When the package finds none, it asks iOS to build it, the way UI test tools do, and turns that off again when the app leaves the front.

## Out of the way

Drag the grndwrk button anywhere. Flick it against the left or right side of the screen, like a video in picture in picture, and it tucks away: only a small tab shows on that edge. Tap the tab, or pull it out, and the button comes back where it was.

## Connected or not

The dot on the button is **green** when grndwrk answers, **orange** when it does not. When it does not, the button says **Offline · 2**, with how many comments wait. A short message says when grndwrk is found or lost.

## On your iPhone, over Wi-Fi

Start grndwrk with `grndwrk --lan`. The app finds your Mac by itself on the same Wi-Fi, so there is no address to type. Two keys in the app's debug Info.plist let iOS allow that:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Send comments to grndwrk on your Mac.</string>
<key>NSBonjourServices</key>
<array><string>_grndwrk._tcp</string></array>
```

The first time, iOS asks whether the app may find devices on the local network. Answer yes.

Then the phone asks to pair: grndwrk in the browser on the Mac shows "wants to send comments", with four digits and the phone's address. The phone shows the same four digits. Click **Allow** only if they match, then confirm on the phone that you did; the phone gets its own key and is paired for that project for good. (Something else on the Wi-Fi could pose as grndwrk and allow at once: the phone asks you, because only you know whether you clicked Allow on your own Mac.) If the map is not open on the Mac, or nobody answers, the app asks for the **pairing code** grndwrk prints in the terminal (`Pairing code: ABC234`) instead; it is sent once, for a key of the phone's own. Until paired, comments wait on the phone and the dot on the grndwrk button is yellow. To pair again, long press the grndwrk button, then **Pair with the Mac** or **Enter pairing code**. Delete `.grndwrk/lan-code` on the Mac for a new code, and `.grndwrk/lan-devices.json` to unpair every phone. Phones paired before keys (November 2026) pair once more.

With `--lan`, paired devices can only add comments, and ask about or delete their own. They cannot read the map or change anything else. Comments sent over the network are marked `via: lan`, and grndwrk's commands treat their text as a report, never as instructions. A paired phone sends comments and pictures only to a grndwrk that first proves it holds the phone's key (it answers a fresh challenge with an HMAC of it), and signs every request with the key (method, path, time, a one-time nonce and the body) rather than sending it, so another device announcing the same project, or anyone recording the traffic, gets nothing it can reuse. The connection is still plain HTTP, so others on the same Wi-Fi could read comments and pictures on the way, and the key at the moment of pairing. Leave `--lan` off on networks you do not trust. In the Simulator, on localhost, no key is needed.

## Your comments on the phone

Long press the grndwrk button, then **Show comments**. It opens on an overview: the connection, and how many fixes are ready to test, comments wait to be sent, and comments were sent. Each opens its list, and each comment its own page, with the picture taken when it was made.

**Testing fixes.** A fix is ready to test once Claude has built it (`/feedback` when you ask it to fix, `/decisions` after a commit, or the product's own Claude Code); a fix that is only proposed never shows up here. Claude writes what changed and, after **To test:**, the steps. When fixes are ready, the grndwrk button gets a second part after a thin line: the test icon and how many, **💬 grndwrk │ ✓ 2**. Tap that part (with one fix it starts testing it right away), or tap **Test** next to one in the list. The rest of the button is for commenting, as always. The list closes, the app goes to the screen when it can, and a card stays on top with what changed and the steps. The steps are a checklist: mark each **Works** or **No** as you go. Try it, then **Approve: it works** (fixed in grndwrk) or **Reject** (it goes back with what is still wrong, for the next `/feedback`; the note starts with the steps you marked No). Drag the card up or down to see what is under it (it stays there for the next test); the computer icon opens the comment in grndwrk on the Mac, with its whole thread; the arrow folds it to one line; the cross stops testing. **Show on my Mac** on a comment's page opens it in grndwrk with its thread.

To go to the screen by itself, tell the package how the app opens screens by name:

```swift
GrndwrkFeedback.openScreen = { name in
  switch name {
  case "Planner": router.show(.planner); return true
  default: return false
  }
}
```

Without it, the card says which screen to go to.

The lists:
- **The connection,** in words, and what to check when it is off.
- **Waiting to be sent:** comments that have not reached grndwrk yet. The menu has Send now and Share as a file, and a swipe deletes one.
- **Ready to test:** comments of yours whose fix is built, with what changed and how to test it. Swipe right to approve one quickly. A fixed comment can be reopened from its page.
- **Sent to grndwrk:** comments that arrived, as they are in grndwrk now: a title you changed there, its status, and the id, for example `n_usez`. A swipe deletes one here **and in grndwrk**. If grndwrk is not reachable, it is deleted there once it is. Comments deleted in grndwrk disappear here.

Pull down to check the connection, send what waits and update the list.

Each comment carries a random key that only the phone knows. grndwrk keeps it with the comment, and only a phone that holds the key can ask about the comment or delete it.

Apps can open the same list from their own debug menu with `GrndwrkFeedback.showComments()`.

Giving important elements an `.accessibilityIdentifier("book-button")` makes comments easier to trace back to the code. It helps UI tests and VoiceOver too.

## Without grndwrk running

Comments are kept on the device and sent once grndwrk answers, oldest first. They are also sent when the app comes back to the foreground. The button shows how many wait: **Offline · 2**.

## Colleagues away from your Wi-Fi

A colleague who tests at home, or anywhere without your grndwrk on the Wi-Fi, sends through your team's relay: a small server you put on your own Cloudflare account with `grndwrk relay deploy` (see grndwrk's README). It only passes on sealed envelopes, and cannot read them.

1. In the map, the globe at the bottom of the rail: **Colleagues**, type their name, **Invite**. It shows a link and a QR code. Send the link (or show the code). It works once, for seven days.
2. In the app, they long press the grndwrk button, **Join with an invite**, and paste the link (`grndwrk:invite/...`), or **Scan the QR code**. The phone shows four digits.
3. A grndwrk on your team shows "A phone joined with Anna's invite" with four digits. Allow it when Anna's phone shows the same; until then her comments wait on her phone (long press, **Show the digits to be allowed**, shows them again). From then on, when no grndwrk answers on their Wi-Fi, comments go to the relay. They reach the map when a grndwrk on the team runs, marked with their name. What became of them (fix proposed, ready to test, fixed, with the steps) comes back the same way, so they test fixes as you do.

Its key is kept in the Keychain, on this device only. The phone still tries the Wi-Fi first. **Leave the relay**, in the same menu, stops it; joining again needs a new invite. In the map, Colleagues lists who joined; Remove takes a phone out at once.

**Scanning needs the camera,** so the app's Info.plist must say why: `NSCameraUsageDescription`, for example "To scan an invite from grndwrk". Put it in the Info.plist of the builds that have the package. Without it, the app offers only pasting the link.

### A Beta build for TestFlight

Colleagues usually get the app from TestFlight. A TestFlight build is a Release build, where the package does nothing, and the same build can later be sent to the App Store. So give testers a build configuration of their own:

1. In Xcode, the project's **Info** tab, **Configurations**: duplicate **Release** and name it **Beta**.
2. In the target's **Build Settings**, for **Beta** only: **Active Compilation Conditions** add `BETA`; point **Info.plist File** at a Beta Info.plist that has the keys the package needs (local network, Bonjour, `NSAllowsLocalNetworking`, the camera).
3. Start the package only in Debug and Beta:

   ```swift
   #if DEBUG
   GrndwrkFeedback.start()
   #elseif BETA
   GrndwrkFeedback.start(allowOutsideDebug: true)
   #endif
   ```

4. Make a scheme **MyApp Beta** whose **Archive** uses **Beta**, and archive with it for TestFlight. Archive the App Store build with the usual scheme (Release).

The Release build has no call to the package, so nothing of it runs there, and in an App Store build it refuses to run anyway. Keep the package out of the Release build entirely if you can (a separate target, or linking it only for Debug and Beta), so App Review never sees it.

## Testers

A tester runs a build with the package, but has no grndwrk. A Debug build installed from Xcode works as is. For an Ad Hoc or TestFlight build, call `start(allowOutsideDebug: true)` in a separate build configuration made for testers, and never submit that build to the App Store (it does nothing there anyway, but App Review may still reject what is compiled in).
1. They comment as usual. Everything waits on their device.
2. A long press on the grndwrk button, then **Share 3 comments as a file**, sends one file by AirDrop, mail or chat.
3. You add it to the map:

   ```
   grndwrk import-feedback grndwrk-feedback-2026-10-08T1432.json
   ```

Comments that are already in the map are skipped. Pictures are included.

Long press also has **Hide the grndwrk button**, until the next launch: quit the app (swipe it away in the app switcher) and open it again, and the button is back. Nothing is lost while it is hidden: waiting comments stay on the phone and go once it is back.

## If comments are not sent

The list of comments (long press, then **Show comments**) and the long-press menu say why the phone is not connected: no grndwrk found on the Wi-Fi, Local Network access turned off, an advert with nothing behind it, or what /api/hello answered. Every step is also logged: in Console.app, pick the phone and filter on `subsystem:GrndwrkFeedback`.

When several Grndwrks are on the network, the phone tries each until one answers, the project it used last first.

- **"Blocked by App Transport Security".** Add `NSAppTransportSecurity` > `NSAllowsLocalNetworking` = YES to the debug Info.plist.
- **On an iPhone, nothing arrives.** Check that grndwrk runs with `--lan`, that both are on the same Wi-Fi, that the two Info.plist keys are there, and that local network access is on in Settings > Privacy & Security > Local Network.
- **"Needs the pairing code".** Long press the grndwrk button, then **Pair with the Mac** and click Allow in the browser, or **Enter pairing code** and type the one from the terminal. After ten wrong codes the phone is shut out for ten minutes (and after thirty from the whole network, typing codes stops for an hour; Allow in the browser still works).
- **A fixed address.** `GrndwrkFeedback.start(server: URL(string: "http://192.168.1.20:7779")!)` skips discovery.
