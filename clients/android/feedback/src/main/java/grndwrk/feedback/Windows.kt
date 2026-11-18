package grndwrk.feedback

import android.app.Activity
import android.graphics.Point
import android.os.Build
import android.view.View
import android.view.WindowManager
import android.view.inspector.WindowInspector

/**
 * The app's windows in front of the activity's own: a dialog, a bottom sheet,
 * Compose's Dialog or ModalBottomSheet. Each is a window of its own, above the
 * activity, so the grndwrk button (a panel on the activity's window) went
 * under it, and picking and pictures read the screen behind it. iOS keeps its
 * button above every window; this lets Android do the same.
 *
 * Read with WindowInspector, from Android 10. Before that, only the activity's
 * own window is known. grndwrk's own windows (titled "grndwrk") never count.
 */
internal object Windows {
  /** grndwrk's own windows and dialogs carry this title, so they are never taken for the app's. */
  const val OWN = "grndwrk"

  /** The app's windows above the activity, the frontmost last. Empty when there are none, or before Android 10. */
  fun above(activity: Activity): List<View> {
    if (Build.VERSION.SDK_INT < 29) return emptyList()
    val decor = activity.window?.decorView ?: return emptyList()
    // The activity's app token: a dialog of the activity is added with the same one (its own window token differs).
    val token = activity.window?.attributes?.token ?: return emptyList()
    val all = try { WindowInspector.getGlobalWindowViews() } catch (_: Throwable) { return emptyList() }
    return all.filter { v ->
      val p = v.layoutParams as? WindowManager.LayoutParams ?: return@filter false
      v !== decor && v.isAttachedToWindow && v.isShown && v.width > 0 && v.height > 0 &&
        // A dialog or sheet of this activity: an application window on the activity's token.
        p.type == WindowManager.LayoutParams.TYPE_APPLICATION && p.token === token &&
        p.title?.toString() != OWN
    }
  }

  /** The window in front: the frontmost dialog or sheet, else the activity's own. */
  fun front(activity: Activity): View? = above(activity).lastOrNull() ?: activity.window?.decorView

  /** Where a window sits relative to the activity's window, in pixels: what to add to a position inside it. */
  fun offset(activity: Activity, window: View): Point {
    val decor = activity.window?.decorView ?: return Point(0, 0)
    if (window === decor) return Point(0, 0)
    val a = IntArray(2).also { window.getLocationOnScreen(it) }
    val b = IntArray(2).also { decor.getLocationOnScreen(it) }
    return Point(a[0] - b[0], a[1] - b[1])
  }
}
