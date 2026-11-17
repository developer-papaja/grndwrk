# GrndwrkFeedback for Android

Comment on your running Android app, straight into the grndwrk map. The same package as [GrndwrkFeedback for iOS](../ios/GrndwrkFeedback/README.md), for Jetpack Compose and Views alike.

A small **grndwrk** button floats over the app. Tap it, tap what you want to comment on, then write or say a line. The comment lands in grndwrk on the Feedback page, in a topic named after the screen, with:
- the element, as TalkBack reads it, and its test tag or view id
- the screen, from its title
- a picture of the spot
- the stories that cover that screen

## Never ship it

GrndwrkFeedback is for your own debug builds. It shows a button that sends what is on screen to a Mac, and finds that Mac on the local network. None of that belongs in an app people download.

- **Add it with `debugImplementation` only.** A release build then does not contain it at all. Call it from code in `src/debug/` (see below), so the release build has nothing that refers to it.
- **In a build installed from Google Play it never runs,** even if `start()` is called: it logs an error and does nothing.
- **In any other build that is not debuggable** (a release build for testers) it does nothing unless you call `start(context, allowOutsideDebug = true)`. Never upload such a build to Google Play.
- **Its permissions and plain http stay in the debug build.** The package's manifest adds `INTERNET`, Wi-Fi multicast (for finding grndwrk), `RECORD_AUDIO` (asked only when Speak is tapped) and `usesCleartextTraffic`, since grndwrk on the Mac speaks plain http. With `debugImplementation` they are merged into the debug build only.
- **Check a release build:** `apkanalyzer dex packages app-release.apk | grep grndwrk` and `apkanalyzer manifest print app-release.apk | grep -i -e grndwrk -e usesCleartextTraffic` should print nothing. The second matters even when the code is stripped: with `implementation` instead of `debugImplementation`, the button never starts, but the release app would still allow plain http and ask for the microphone.
- **Backups:** the package keeps waiting comments and their pictures in the app's own files, under `GrndwrkFeedback/`. If your debug build backs up to the cloud, exclude that folder in your debug backup rules. Its keys are sealed in the Android Keystore and never restore elsewhere.

## Add it

1. Add JitPack to the repositories in `settings.gradle.kts`:

   ```kotlin
   dependencyResolutionManagement {
     repositories {
       google()
       mavenCentral()
       exclusiveContent {
         forRepository { maven("https://jitpack.io") }
         filter { includeGroup("com.github.developer-papaja") }
       }
     }
   }
   ```

   `exclusiveContent` ties the two together both ways: JitPack serves only this package, and this package comes only from JitPack, never from another repository that might hold something under the same name. Use a release tag (`v0.4.1`), never a branch or a commit: a tag is what grndwrk's tests and review went through.

2. Add the package to debug builds, with the tag of the grndwrk you run (`grndwrk -v`), so the phone and the map stay in step:

   ```kotlin
   dependencies {
     debugImplementation("com.github.developer-papaja:grndwrk:v0.4.1")
   }
   ```

   JitPack builds it from that tag of the grndwrk repository on GitHub the first time someone asks for it. Everyone on the team gets the same build, CI too; nothing is copied into the app's repository.

   Working on grndwrk itself? Point the app at your checkout in its `settings.gradle.kts` (keep this line out of the app's repository, or behind a property only you set):

   ```kotlin
   includeBuild("/path/to/grndwrk/clients/android") {
     dependencySubstitution { substitute(module("com.github.developer-papaja:grndwrk")).using(project(":feedback")) }
   }
   ```

   Gradle then builds your checkout instead of the one from JitPack.

3. Start it in debug builds only. In `src/debug/java/<your package>/DebugTools.kt`:

   ```kotlin
   object DebugTools {
     fun start(app: Application) = GrndwrkFeedback.start(app)
   }
   ```

   and an empty one in `src/release/java/<your package>/DebugTools.kt`:

   ```kotlin
   object DebugTools {
     fun start(app: Application) {}
   }
   ```

   Then, in your Application:

   ```kotlin
   class App : Application() {
     override fun onCreate() {
       super.onCreate()
       DebugTools.start(this)
     }
   }
   ```

4. Run `grndwrk` in the project, and run the app in the emulator. The emulator reaches your Mac as `10.0.2.2`, and the package looks for grndwrk at `10.0.2.2:7777` first. When grndwrk runs on another port, say where: `GrndwrkFeedback.start(app, server = "http://10.0.2.2:7790")`. Or forward the port once with `adb reverse tcp:7777 tcp:7777`, and the package finds it at `localhost:7777`.

`clients/android/sample` in this repository is a small app (a Compose screen and a Views screen) set up this way. `./gradlew :sample:installDebug -PgrndwrkServer=http://10.0.2.2:7790` from `clients/android` installs it pointed at the grndwrk on port 7790.

## On a phone

On a phone on the same Wi-Fi as the Mac, run `grndwrk --lan`. The package finds it by itself (NSD, `_grndwrk._tcp`). The first time, it asks to be allowed: the map on the Mac shows "wants to send comments" with four digits, the phone shows the same four, and you allow it. Or type the pairing code `grndwrk --lan` prints. From then on the phone has a key of its own for that project, kept in the Android Keystore on this phone only, and signs every request with it; the key itself is never sent again.

Away from the Wi-Fi, colleagues' phones send comments through the team's relay or the team's store: long press the button, **Join with an invite**, and paste the link or scan its QR code.

## Pictures of the screens

While the app is connected, it sends grndwrk a picture of each screen the first time it stays on it for about a second, once per launch. A small camera shows on the grndwrk button when one is taken. The long-press menu says whether the screen you are on has a picture, and **Take a picture of this screen** takes one now. Walk through the app once and the Sitemap view shows what every screen looks like. The grndwrk button is never in the picture, and text fields are drawn empty. Pictures stay on the Mac, in `.grndwrk/shots/android/`, out of git, each with a small `.json` of the texts and ids the screen showed.

A picture is named after the screen's title, or its activity. Screens without a title often share a name like `MainActivity` (every Compose screen of a one-activity app does); the app tells them apart by what they show and sends one picture for each, kept as `MainActivity.jpg`, `MainActivity-2.jpg` and so on. `/sitemap` places them on screens, or drag them there in the Sitemap view.

**Naming a screen without a title.** In Compose:

```kotlin
PlannerScreen(Modifier.grndwrkScreen("Planner"))
```

In Views, add a `GrndwrkScreenName(context, "Planner")` to the screen's layout. Neither changes anything on screen, or anything TalkBack or UI tests read. Comments made on that screen get the name too. A title still wins when there is one. Since the package is in debug builds only, call these from code that is in debug builds only too, or keep a no-op of the same name in `src/release`.

To turn it off: `GrndwrkFeedback.collectsScreenshots = false` after `start()`.

## Commenting

1. Tap **Comment**, then tap what you mean. A blue outline shows what was picked, and a bar at the bottom names it.
2. Not quite right? The two arrows in the bar make the pick **smaller** or **bigger**. Or drag the **round handles** on the corners of the blue box to frame any area yourself: the bar then says **Your area** and what it holds.
3. Tap **Comment** in the bar. A sheet opens with a picture of the spot: type, or tap **Speak** and say it (the language button picks which language to listen for), or tap **Write on the Mac** to write it in grndwrk in the browser.

Elements are read the way TalkBack reads them: Compose semantics (text, content description, role, test tag) and each View's accessibility details. A text field's contents are never sent, only its label.

## Out of the way

Drag the grndwrk button anywhere. Flick it against the left or right side and it tucks away into a small tab on that edge; tap the tab, or pull it out, to bring it back. Long press it for the menu: where comments go, this screen as the map has it, Test N fixes, Show comments, Pair with the Mac, Join with an invite, and Hide.

## Testing fixes

When your agent built a fix for a comment made on this phone, the button gets a second part, the test icon and how many. Tap it: the app goes to the screen the comment was made on (when you set `GrndwrkFeedback.openScreen`), and a card shows what changed and the steps to test, each with Works and No. **Approve** marks it fixed in the map. **Reject** asks what is still wrong and sends it back to your agent. **Reject and write on the Mac** opens it in the map with the reply box ready.

```kotlin
GrndwrkFeedback.openScreen = { name ->
  when (name) {
    "Planner" -> { navController.navigate("planner"); true }
    else -> false
  }
}
```

## Without grndwrk running

Comments are kept on the phone and sent once grndwrk answers. Long press, **Show comments**, then **Save waiting comments as a file** shares them as one file, which `grndwrk import-feedback <file>` adds to the map.

## Troubleshooting

Logcat, tag `GrndwrkFeedback`, shows every step of finding and reaching grndwrk.

- **"blocked by Android: plain http is not allowed"**: the app has its own `networkSecurityConfig`, which overrides `usesCleartextTraffic`. Add a debug-only config that allows cleartext to `10.0.2.2` and your Mac's address, or to everything in debug.
- **Nothing found on the Wi-Fi**: is `grndwrk --lan` running, on the same network? Some guest networks block devices from seeing each other.

## Working on the package

The iOS and Android packages are kept the same: a change to one goes into the other. [clients/TESTING.md](../TESTING.md) has the steps to test both, against a test map of their own.
