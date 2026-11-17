package grndwrk.feedback

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.text.format.DateFormat
import android.util.Base64
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Date

/**
 * Pictures of the screens the app shows, for the Sitemap view in grndwrk.
 * While connected, each screen is taken once per launch, after it has stayed
 * in view for a moment, so walking through the app once collects them all.
 * The grndwrk button lives in a window of its own and is never in the picture.
 * Turn it off with `GrndwrkFeedback.collectsScreenshots = false`.
 */
internal object Snapshots {
  var enabled = true
  /** What was sent this launch, per name: one entry per screen that looked different. */
  private val taken = mutableMapOf<String, MutableList<Set<String>>>()
  private var last: Pair<String, Set<String>>? = null
  private var sending = false
  /** An older grndwrk without screenshots: stop asking until the next launch. */
  private var unsupported = false
  /** When a picture of each screen went to grndwrk this launch, by name. */
  private val sentAt = mutableMapOf<String, Date>()

  /** Whether this screen has a picture yet, in words, for the long-press menu. */
  /**
   * What a picture is kept under: the screen's own name (a title in a toolbar, or a name given with
   * grndwrkScreen), else its activity or fragment. One activity often holds every screen of a Compose
   * app, so a name of its own must win over it, or each screen's picture would replace the last.
   */
  fun keyOf(screen: Inspector.Screen): String = if (screen.named) screen.name else screen.component ?: screen.name

  fun status(activity: Activity?): String {
    if (!enabled) return "Pictures of screens are turned off in this app."
    activity ?: return ""
    val screen = Inspector.screen(activity)
    val at = sentAt[keyOf(screen)]
      ?: return "No picture of “${screen.name}” yet. Stay on it a second, or take one now."
    return "Picture of “${screen.name}” taken ${DateFormat.getTimeFormat(activity).format(at)}."
  }

  /** Take a picture of the screen now, as it is: for when the automatic one showed something else, or none was taken. Replaces the one before. */
  fun takeNow(activity: Activity?) {
    if (!enabled || Connection.state !is Connection.State.Connected || activity == null) return
    val server = Locator.current ?: return
    val contents = Inspector.contents(activity)
    send(activity, Inspector.screen(activity), contents, look(contents), server)
  }

  /** Called every second with the activity in front. `busy` while the person is picking an element or writing a comment. */
  fun tick(activity: Activity?, busy: Boolean) {
    val server = Locator.current
    if (!enabled || unsupported || sending || busy || Connection.state !is Connection.State.Connected || activity == null || server == null) {
      last = null
      return
    }
    val screen = Inspector.screen(activity)
    val key = keyOf(screen)
    val contents = Inspector.contents(activity)
    val look = look(contents)
    val before = last
    last = key to look
    // Only once it has stayed the same for a tick: not halfway through a transition.
    if (before == null || before.first != key || !alike(before.second, look)) return
    // A screen with its own name is taken once. One without, like MainActivity,
    // once for each screen that looks different, since several share the name.
    val sent = taken[key] ?: emptyList<Set<String>>()
    if (if (screen.named) sent.isNotEmpty() else sent.any { alike(it, look) }) return
    send(activity, screen, contents, look, server)
  }

  private fun send(activity: Activity, screen: Inspector.Screen, contents: Pair<List<String>, List<String>>, look: Set<String>, server: String) {
    if (sending) return
    val decor = activity.window?.decorView ?: return
    val key = keyOf(screen)
    sending = true
    Env.scope.launch {
      try {
        val bitmap = Inspector.capture(activity, Rect(0, 0, decor.width, decor.height)) ?: return@launch
        val jpeg = ByteArrayOutputStream().use {
          bitmap.compress(Bitmap.CompressFormat.JPEG, 60, it)
          it.toByteArray()
        }
        val body = JSONObject()
          .put("platform", "android").put("screen", screen.name).put("named", screen.named)
          .put("texts", JSONArray(contents.first.take(60))).put("ids", JSONArray(contents.second))
          .put("image", "data:image/jpeg;base64," + Base64.encodeToString(jpeg, Base64.NO_WRAP))
        // grndwrk keeps the picture under `component` when there is one: the key, so a screen with a name of its own is kept under that name.
        body.put("component", key)
        val status = try {
          Pairing.post(server, "api/screenshot", body.toString().toByteArray(), 15_000).status
        } catch (e: Why) {
          gwLog.error("A picture of $key was not sent: ${e.words}")
          0
        }
        when (status) {
          200, 201 -> {
            taken.getOrPut(key) { mutableListOf() }.add(look)
            sentAt[key] = Date()
            Bus.post(Bus.TOOK_PICTURE, mapOf("screen" to screen.name))
            gwLog.info("Sent a picture of $key")
          }
          404 -> {
            unsupported = true
            gwLog.info("This grndwrk does not take pictures of screens yet")
          }
          0 -> {}
          else -> gwLog.error("A picture of $key was not taken ($status)")
        }
      } finally {
        sending = false
      }
    }
  }

  /** The texts and ids, without digits, so a clock or a count does not make the same screen look new. */
  fun look(contents: Pair<List<String>, List<String>>): Set<String> =
    (contents.first + contents.second).map { it.lowercase().replace(Regex("[0-9]+"), "#") }.toSet()

  /** The same screen: at least half of what either shows is shared. Nothing to compare counts as the same. */
  fun alike(a: Set<String>, b: Set<String>): Boolean {
    if (a.isEmpty() || b.isEmpty()) return true
    return (a intersect b).size.toDouble() / (a union b).size >= 0.5
  }
}
