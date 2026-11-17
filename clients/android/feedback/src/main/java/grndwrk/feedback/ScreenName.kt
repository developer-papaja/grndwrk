package grndwrk.feedback

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import android.view.View

/**
 * An invisible view that names the screen it sits on, for screens without a
 * title. Add it to the screen's layout in a debug build: it draws nothing,
 * takes no touches and is not read by TalkBack.
 *
 *     layout.addView(GrndwrkScreenName(context, "Planner"))
 *
 * In Jetpack Compose, use `Modifier.grndwrkScreen("Planner")` instead.
 */
class GrndwrkScreenName(context: Context, var name: String) : View(context) {
  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    isClickable = false
    isFocusable = false
    setWillNotDraw(true)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) = setMeasuredDimension(1, 1)

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent?): Boolean = false
}
