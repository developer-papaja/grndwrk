package grndwrk.feedback

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import java.lang.ref.WeakReference

/**
 * Comment on your running app, straight into the grndwrk map.
 *
 * Call `GrndwrkFeedback.start(this)` once, in a debug build, from your
 * Application's onCreate. A small grndwrk button floats over the app. Tap it,
 * tap what you want to comment on, write or say a line, and it lands in
 * grndwrk on the Feedback page, with the element, the screen and a picture
 * of the spot.
 *
 *     class App : Application() {
 *       override fun onCreate() {
 *         super.onCreate()
 *         if (BuildConfig.DEBUG) GrndwrkFeedback.start(this)
 *       }
 *     }
 *
 * Add the package with `debugImplementation` only, so it is never in a build
 * people download (see the README); then call it through the debug source
 * set, or by reflection as the README shows.
 */
object GrndwrkFeedback {
  private var started = false
  private var visible = 0
  private var current: WeakReference<Activity>? = null

  /** The activity in front, if any. */
  internal val activity: Activity? get() = current?.get()

  /**
   * Show the grndwrk button. Without `server`, it finds grndwrk by itself:
   * on the same Wi-Fi when `grndwrk --lan` runs, and in the emulator also
   * at 10.0.2.2:7777 (the Mac). Comments written while grndwrk cannot be
   * reached are kept on the device and sent once it can.
   *
   * It is a tool for your own debug builds. In a build from Google Play it
   * never runs. In other builds that are not debuggable it runs only with
   * `allowOutsideDebug = true`; never upload such a build to Google Play.
   */
  @JvmStatic
  @JvmOverloads
  fun start(context: Context, server: String? = null, allowOutsideDebug: Boolean = false) {
    Env.app = context.applicationContext
    if (started || !Distribution.mayRun(allowOutsideDebug)) return
    started = true
    Locator.fixed = server?.trimEnd('/')
    val app = Env.app as Application
    app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(a: Activity) {
        if (visible++ == 0) Connection.resume()
      }
      override fun onActivityResumed(a: Activity) {
        current = WeakReference(a)
        if (started) Overlay.attach(a)
      }
      override fun onActivityPaused(a: Activity) { Overlay.detach(a) }
      override fun onActivityStopped(a: Activity) {
        if (--visible == 0) Connection.pause()
      }
      override fun onActivityCreated(a: Activity, b: Bundle?) {}
      override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
      override fun onActivityDestroyed(a: Activity) {
        if (current?.get() === a) current = null
      }
    })
    // Started after an activity is already up (from an activity, or late): float over it now.
    if (context is Activity) {
      visible = 1
      current = WeakReference(context)
      Connection.resume()
      Overlay.attach(context)
    }
  }

  /** Open the list of comments: the ones waiting to be sent, and the ones sent. The same as a long press on the grndwrk button, then Show comments. */
  @JvmStatic
  fun showComments() = Overlay.showComments()

  /** Send a picture of each screen the app shows to grndwrk, for its Sitemap view: once per screen per launch, while connected. On by default. */
  @JvmStatic
  var collectsScreenshots: Boolean
    get() = Snapshots.enabled
    set(value) { Snapshots.enabled = value }

  /**
   * Opens a screen of the app by the name comments carry (its title,
   * `grndwrkScreen` name or activity). When set, testing a fix goes to the
   * screen the comment was made on first. Return false when the name is not
   * one the app can open.
   *
   *     GrndwrkFeedback.openScreen = { name ->
   *       when (name) {
   *         "Planner" -> { navController.navigate("planner"); true }
   *         else -> false
   *       }
   *     }
   */
  @JvmStatic
  var openScreen: ((String) -> Boolean)? = null

  /** Hide the grndwrk button until the next `start()`. */
  @JvmStatic
  fun stop() {
    activity?.let { Overlay.detach(it) }
    started = false
  }

  /** Send a comment on whatever sits at (x, y) in the window, in pixels, without tapping. For checking the setup from code. */
  @JvmStatic
  fun comment(x: Int, y: Int, text: String) = Overlay.comment(x, y, text)
}
