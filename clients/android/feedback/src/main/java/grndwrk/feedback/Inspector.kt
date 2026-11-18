package grndwrk.feedback

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Finds what was tapped: the elements TalkBack reads, and the boxes the eye
 * sees (cards, rows, backgrounds), from the smallest to the largest. Views
 * are read from the view tree, Jetpack Compose from its semantics tree.
 */
internal object Inspector {
  /** What was picked. `frame` is in the activity window's coordinates, in pixels. */
  data class Found(val frame: Rect, val label: String?, val identifier: String?, val role: String) {
    fun describe(): String = label?.let { "$role “${it.take(40)}”" } ?: role
  }

  /** The screen in view. */
  data class Screen(
    /** The title when there is one, the name given with GrndwrkScreenName or Modifier.grndwrkScreen, or the activity's or fragment's name. */
    val name: String,
    /** The activity or fragment class, like BookingActivity, when it can be read. */
    val component: String?,
    /** Whether the name is the screen's own: a title, or a given name. Without one, screens that look nothing alike can share a name like MainActivity. */
    val named: Boolean,
  )

  /** One thing on screen, from Views or Compose alike. Elements are what TalkBack reads; the rest are boxes. */
  class Node(
    val frame: Rect,
    val label: String?,
    val identifier: String?,
    val role: String,
    val element: Boolean,
    val textEntry: Boolean = false,
    /** A tab of a bottom bar, which every screen shares. */
    val tab: Boolean = false,
  )

  private val hasCompose: Boolean by lazy {
    try {
      Class.forName("androidx.compose.ui.node.RootForTest")
      true
    } catch (_: Throwable) {
      false
    }
  }

  fun clean(s: CharSequence?): String? {
    val t = s?.toString()?.trim() ?: return null
    return if (t.isEmpty()) null else t.take(200)
  }

  /** Everything the window shows, and the names given to the screen (frontmost last). */
  private class Tree(val nodes: List<Node>, val given: List<Pair<String, Rect>>)

  private fun read(activity: Activity): Tree {
    val out = mutableListOf<Node>()
    val given = mutableListOf<Pair<String, Rect>>()
    val root = activity.window?.decorView ?: return Tree(out, given)
    var visited = 0
    fun visit(v: View, depth: Int) {
      visited++
      if (depth > 60 || visited > 8000) return
      if (v.visibility != View.VISIBLE || v.alpha < 0.01f) return
      val frame = Rect()
      if (!v.getGlobalVisibleRect(frame) || frame.isEmpty) return
      if (v is GrndwrkScreenName) {
        clean(v.name)?.let { given += it to frame }
        return
      }
      if (hasCompose && ComposeSemantics.isComposeView(v)) {
        try {
          ComposeSemantics.collect(v, out, given)
        } catch (e: Throwable) {
          gwLog.error("Could not read the Compose screen: ${e.message}")
        }
      } else {
        out += viewNode(v, frame)
      }
      // Views inside Compose (AndroidView) and every other view's children.
      if (v is ViewGroup && v.importantForAccessibility != View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS) {
        for (i in 0 until v.childCount) visit(v.getChildAt(i), depth + 1)
      }
    }
    visit(root, 0)
    return Tree(out, given)
  }

  private fun viewNode(v: View, frame: Rect): Node {
    val entry = isTextEntry(v)
    val description = clean(v.contentDescription)
    // A field's value is what was typed in it: never its label.
    val label = description ?: if (entry) clean((v as? TextView)?.hint) else clean((v as? TextView)?.text)
    val important = v.importantForAccessibility != View.IMPORTANT_FOR_ACCESSIBILITY_NO &&
      v.importantForAccessibility != View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    val element = important && (label != null || entry || v.isClickable || v.isLongClickable)
    return Node(frame, label, identifier(v), if (element) role(v) else "area", element, entry)
  }

  /** The view's id by name, as the app wrote it (`R.id.save` is "save"). Ids of Android's own layouts say nothing. */
  private fun identifier(v: View): String? {
    if (v.id == View.NO_ID || v.id <= 0) return null
    return try {
      if (v.resources.getResourcePackageName(v.id) == "android") null else clean(v.resources.getResourceEntryName(v.id))
    } catch (_: Exception) {
      null
    }
  }

  private fun role(v: View): String {
    val name = v.accessibilityClassName?.toString() ?: v.javaClass.name
    return when {
      name.endsWith("SearchView") || name.endsWith("SearchAutoComplete") -> "search field"
      isTextEntry(v) -> "text field"
      name.endsWith("Switch") || name.endsWith("SwitchCompat") || name.endsWith("ToggleButton") -> "switch"
      name.endsWith("CheckBox") -> "checkbox"
      name.endsWith("RadioButton") -> "radio button"
      name.endsWith("SeekBar") || name.endsWith("Slider") -> "slider"
      name.endsWith("ImageButton") || name.endsWith("Button") -> "button"
      name.endsWith("ImageView") -> if (v.isClickable) "button" else "image"
      v.isClickable -> "button"
      v is TextView -> "text"
      else -> "element"
    }
  }

  /** Whether this is something a person types into: its text is what they typed. */
  private fun isTextEntry(v: View): Boolean = v is EditText || (v is TextView && v.onCheckIsTextEditor())

  private fun area(r: Rect) = r.width().toLong() * r.height()

  private fun windowArea(activity: Activity): Long {
    val d = activity.window?.decorView ?: return 1
    return max(1L, d.width.toLong() * d.height)
  }

  /** The smallest accessibility element under the point. For the self test. */
  fun element(activity: Activity, x: Int, y: Int): Found = candidates(activity, x, y).let { it[preferred(it)] }

  /** Which candidate to start from: the smallest element TalkBack would read. */
  fun preferred(list: List<Found>): Int = list.indexOfFirst { it.role != "area" }.let { if (it < 0) 0 else it }

  /**
   * Everything under the point, from the smallest to the largest, so the
   * person can step out from a label to its card, or back in. Never empty.
   */
  fun candidates(activity: Activity, x: Int, y: Int): List<Found> {
    val screen = windowArea(activity)
    val tooBig = { r: Rect -> area(r) > screen * 0.85 }
    val tree = read(activity).nodes
    val elements = tree.filter { it.element }
    val boxes = tree.filter { !it.element && it.frame.contains(x, y) && !tooBig(it.frame) }

    var under = elements.filter { it.frame.contains(x, y) }
    // A tap between two words of a card: take the nearest element, if close.
    if (under.isEmpty()) {
      val reach = 24 * activity.resources.displayMetrics.density
      elements.map { it to distance(x, y, it.frame) }.filter { it.second < reach }.minByOrNull { it.second }?.let { under = listOf(it.first) }
    }

    val list = under.map { Found(Rect(it.frame), it.label, it.identifier, it.role) }.toMutableList()
    for (box in boxes) {
      val grown = Rect(box.frame).apply { inset(-2, -2) }
      val label = readingOrder(elements.filter { grown.contains(it.frame) }).mapNotNull { it.label }.distinct().take(4).joinToString(" · ")
      list += Found(Rect(box.frame), label.ifEmpty { null }?.take(120), box.identifier, "area")
    }

    // Smallest first. Of two the same size, an element beats an area.
    list.sortWith { a, b ->
      val sa = area(a.frame)
      val sb = area(b.frame)
      if (abs(sa - sb) > 1) sa.compareTo(sb) else (if (a.role != "area" && b.role == "area") -1 else if (a.role == "area" && b.role != "area") 1 else 0)
    }
    val out = mutableListOf<Found>()
    // The same box within 3dp on every side, as iOS's 3 points: in pixels, a card and the padding
    // around it were two steps, and Smaller or Bigger seemed to do nothing.
    val near = 3 * activity.resources.displayMetrics.density
    for (f in list) {
      val i = out.indexOfFirst { same(it.frame, f.frame, near) }
      if (i >= 0) {
        // The same box seen twice: keep what says most about it.
        out[i] = out[i].copy(identifier = out[i].identifier ?: f.identifier, label = out[i].label ?: f.label)
        continue
      }
      out += f
    }
    if (out.isEmpty()) {
      val r = (22 * activity.resources.displayMetrics.density).toInt()
      out += Found(Rect(x - r, y - r, x + r, y + r), null, null, "spot")
    }
    return out
  }

  private fun same(a: Rect, b: Rect, near: Float) = abs(a.left - b.left) < near && abs(a.top - b.top) < near && abs(a.right - b.right) < near && abs(a.bottom - b.bottom) < near

  private fun distance(x: Int, y: Int, r: Rect): Float {
    val dx = max(max(r.left - x, 0), x - r.right).toFloat()
    val dy = max(max(r.top - y, 0), y - r.bottom).toFloat()
    return sqrt(dx * dx + dy * dy)
  }

  /** Top to bottom, then left to right. */
  private fun readingOrder(list: List<Node>): List<Node> =
    list.sortedWith { a, b -> if (abs(a.frame.top - b.frame.top) > 4) a.frame.top.compareTo(b.frame.top) else a.frame.left.compareTo(b.frame.left) }

  /** The screen in view: its title, a name given to it, or the activity's or fragment's class. */
  fun screen(activity: Activity): Screen {
    val component = fragmentName(activity) ?: activity.javaClass.simpleName.ifEmpty { null }
    val bar = barTitle(activity)
    val given = if (bar == null) read(activity).given.lastOrNull()?.first else null
    // The activity's own title names the screen, but is not its own: in a Compose app every screen shares it.
    val own = clean(activity.title)?.takeIf { it != clean(Env.appName) }
    return Screen(bar ?: given ?: own ?: component ?: "App", component, bar != null || given != null)
  }

  /** The title in the toolbar or action bar, when it is not just the app's name: it changes with the screen. */
  private fun barTitle(activity: Activity): String? {
    val appName = clean(Env.appName)
    val bar = clean(activity.actionBar?.takeIf { it.isShowing }?.title)
    if (bar != null && bar != appName) return bar
    toolbarTitle(activity.window?.decorView)?.let { if (it != appName) return it }
    return null
  }

  /** The title of a visible Toolbar (Android's or AndroidX's), read by its getTitle without depending on AppCompat. */
  private fun toolbarTitle(root: View?): String? {
    var found: String? = null
    fun visit(v: View, depth: Int) {
      if (found != null || depth > 40 || v.visibility != View.VISIBLE) return
      if (v.javaClass.name.endsWith("Toolbar")) {
        found = try { clean(v.javaClass.getMethod("getTitle").invoke(v) as? CharSequence) } catch (_: Exception) { null }
        if (found != null) return
      }
      if (v is ViewGroup) for (i in 0 until v.childCount) visit(v.getChildAt(i), depth + 1)
    }
    root?.let { visit(it, 0) }
    return found
  }

  /** The class of the frontmost AndroidX fragment, by reflection: grndwrk does not depend on fragments. NavHostFragment is a wrapper, so the fragment inside it counts. */
  private fun fragmentName(activity: Activity): String? = try {
    var manager: Any? = activity.javaClass.getMethod("getSupportFragmentManager").invoke(activity)
    var name: String? = null
    while (manager != null) {
      @Suppress("UNCHECKED_CAST")
      val fragments = manager.javaClass.getMethod("getFragments").invoke(manager) as List<Any>
      val top = fragments.lastOrNull { f -> (f.javaClass.getMethod("isVisible").invoke(f) as? Boolean) == true } ?: break
      val simple = top.javaClass.simpleName
      if (simple != "NavHostFragment" && simple.isNotEmpty()) name = simple
      manager = top.javaClass.getMethod("getChildFragmentManager").invoke(top)
    }
    name
  } catch (_: Throwable) {
    null
  }

  /**
   * What the screen shows: the texts TalkBack would read and the ids, top to
   * bottom, without the bottom bar's tabs, which every screen shares. Enough
   * to tell two screens with the same name apart.
   */
  fun contents(activity: Activity): Pair<List<String>, List<String>> {
    val nodes = readingOrder(read(activity).nodes.filter { !it.tab && (it.identifier != null || (it.element && it.label != null)) })
    val texts = nodes.mapNotNull { if (it.element) it.label?.take(80) else null }.distinct().take(60)
    val ids = nodes.mapNotNull { it.identifier }.distinct().take(60)
    return texts to ids
  }

  /** An area the person framed by hand: what TalkBack reads inside it, top to bottom, and the first id there. */
  fun area(activity: Activity, frame: Rect): Found {
    val grown = Rect(frame).apply { inset(-2, -2) }
    val inside = readingOrder(read(activity).nodes.filter { it.element && grown.contains(it.frame) })
    val label = inside.mapNotNull { it.label }.distinct().take(4).joinToString(" · ")
    return Found(Rect(frame), label.ifEmpty { null }?.take(120), inside.firstNotNullOfOrNull { it.identifier }, "area")
  }

  /**
   * Where the window's text fields are, to draw over what they hold: every field that is drawn,
   * whatever accessibility says about it. A drawer that is open, or a bottom sheet, hides the
   * content behind it from TalkBack while it is still drawn, so this is a walk of its own, as
   * iOS's textFields is, never the TalkBack walk. Null when the window cannot be read in full
   * (too deep, too many views, Compose that will not read): then no picture is taken at all.
   */
  fun textFields(activity: Activity): List<Rect>? {
    val root = activity.window?.decorView ?: return null
    val out = mutableListOf<Rect>()
    var visited = 0
    var complete = true
    fun visit(v: View, depth: Int) {
      if (!complete) return
      if (++visited > 20_000 || depth > 200) {
        complete = false
        return
      }
      if (v.visibility != View.VISIBLE) return
      if (hasCompose && ComposeSemantics.isComposeView(v)) {
        try {
          val nodes = mutableListOf<Node>()
          ComposeSemantics.collect(v, nodes, mutableListOf())
          nodes.filter { it.textEntry }.forEach { out += it.frame }
        } catch (e: Throwable) {
          gwLog.error("Could not find the text fields of a Compose screen, so no picture is taken: ${e.message}")
          complete = false
          return
        }
      } else if (isTextEntry(v)) {
        val frame = Rect()
        if (v.getGlobalVisibleRect(frame) && !frame.isEmpty) out += frame
      }
      if (v is ViewGroup) for (i in 0 until v.childCount) visit(v.getChildAt(i), depth + 1)
    }
    visit(root, 0)
    return if (complete) out else null
  }

  /** The window as it is now, through PixelCopy, at most 2x the density. Null when it cannot be copied. */
  suspend fun capture(activity: Activity, area: Rect): Bitmap? {
    val window = activity.window ?: return null
    if (area.width() < 2 || area.height() < 2) return null
    val scale = min(1f, 2f / activity.resources.displayMetrics.density)
    // Where the fields are, read on the same frame as the copy: what they hold never reaches a picture.
    val fields = textFields(activity) ?: return null
    val full = Bitmap.createBitmap(area.width(), area.height(), Bitmap.Config.ARGB_8888)
    val ok = suspendCancellableCoroutine { done ->
      try {
        PixelCopy.request(window, area, full, { result -> done.resume(result == PixelCopy.SUCCESS) }, Handler(Looper.getMainLooper()))
      } catch (e: Exception) {
        gwLog.error("The screen could not be copied: ${e.message}")
        done.resume(false)
      }
    }
    if (!ok) return null
    blank(full, fields, area, activity.resources.displayMetrics.density)
    if (scale >= 1f) return full
    return Bitmap.createScaledBitmap(full, max(1, (full.width * scale).toInt()), max(1, (full.height * scale).toInt()), true).also { full.recycle() }
  }

  /** A picture of the area around the element, for context in the map, as a PNG. Text fields are drawn empty. */
  suspend fun crop(activity: Activity, frame: Rect): ByteArray? {
    val decor = activity.window?.decorView ?: return null
    val margin = (48 * activity.resources.displayMetrics.density).toInt()
    val area = Rect(frame).apply { inset(-margin, -margin) }
    if (!area.intersect(0, 0, decor.width, decor.height)) return null
    val bitmap = capture(activity, area) ?: return null
    return ByteArrayOutputStream().use {
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
      it.toByteArray()
    }
  }

  /** What a field holds stays on the phone: drawn as an empty box in pictures, as the web button and iOS do. */
  private fun blank(bitmap: Bitmap, fields: List<Rect>, area: Rect, density: Float) {
    if (fields.isEmpty()) return
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(242, 242, 247) }
    for (f in fields) {
      val r = RectF(f).apply { offset(-area.left.toFloat(), -area.top.toFloat()) }
      val radius = min(8 * density, r.height() / 4)
      canvas.drawRoundRect(r, radius, radius, paint)
    }
  }
}
