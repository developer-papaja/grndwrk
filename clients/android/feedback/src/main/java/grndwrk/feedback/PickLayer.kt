package grndwrk.feedback

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * The layer over the app while picking: it takes the tap, draws the blue box
 * around what is picked with a handle on each corner, and holds the bar that
 * names it, with Smaller, Bigger and Comment. In its own window above the
 * app's, so no picture of the app ever shows it.
 */
@SuppressLint("ViewConstructor")
internal class PickLayer(context: Context, private val events: Events) : FrameLayout(context) {
  interface Events {
    /** A tap at this point of the layer. */
    fun tapped(x: Float, y: Float)
    /** The box was framed by hand (a corner or the inside dragged); `done` once the finger lets go. */
    fun framed(box: RectF, done: Boolean)
    fun step(by: Int)
    fun close()
    fun comment()
  }

  /** Picking, or only showing the box while the comment is written. */
  var marking = false
    set(value) {
      field = value
      bar.visibility = GONE
      hint.visibility = GONE
      invalidate()
    }

  /** The box around what is picked, in this layer's coordinates. */
  var box: RectF? = null
    private set

  private val blue = Colors.blue
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = blue; strokeWidth = context.dp(2).toFloat() }
  private val tint = Paint().apply { color = Colors.alpha(blue, 0.08f) }
  private val knob = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
  private val knobRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = blue; strokeWidth = context.dp(2.5f).toFloat() }
  private val shadow = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x40000000 }
  private val dim = 0x0F000000

  val hint: TextView = context.label("Tap what you want to comment on", 13f, Colors.light, bold = true).apply {
    background = rounded(Colors.dark, context.dp(8).toFloat())
    setPadding(context.dp(12), context.dp(6), context.dp(12), context.dp(6))
  }
  val bar = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    background = rounded(Colors.dark, context.dp(20).toFloat())
    elevation = context.dp(10).toFloat()
    setPadding(context.dp(14), context.dp(8), context.dp(8), context.dp(10))
    visibility = GONE
    isClickable = true
  }
  private val barLabel = context.label("", 15f, Colors.light, bold = true, lines = 2)
  private val smaller: TextView
  private val bigger: TextView

  init {
    setWillNotDraw(false)
    setBackgroundColor(dim)
    addView(hint, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL))
    val close = context.pill(null, Glyph.CLOSE, 0, Colors.light, "Stop picking") { events.close() }
    // First row: what is picked, in full, and a way out.
    val top = horizontal(context, context.dp(4), barLabel.fill(), close)
    smaller = context.pill("Smaller", Glyph.SMALLER, 0, Colors.light) { events.step(-1) }
    bigger = context.pill("Bigger", Glyph.BIGGER, 0, Colors.light) { events.step(1) }
    smaller.setPadding(context.dp(10), context.dp(10), context.dp(10), context.dp(10))
    bigger.setPadding(context.dp(10), context.dp(10), context.dp(10), context.dp(10))
    // Second row: change the pick, then comment.
    val go = context.pill("Comment", Glyph.BUBBLE, blue, 0xFFFFFFFF.toInt()) { events.comment() }
    val actions = horizontal(context, context.dp(4), smaller, bigger, spacer(context), go)
    bar.addView(top, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    bar.addView(actions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = context.dp(6) })
    addView(bar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    contentDescription = "Tap what you want to comment on"
  }

  /** Room the phone's bars and cutouts take: the hint and the bar stay out of it. */
  fun inset(top: Int, bottom: Int) {
    (hint.layoutParams as LayoutParams).topMargin = top + context.dp(8)
    hint.requestLayout()
    barInsets = top to bottom
    placeBar()
  }

  private var barInsets = 0 to 0
  private var barBelow = true

  private fun placeBar() {
    val lp = bar.layoutParams as LayoutParams
    lp.gravity = if (barBelow) Gravity.BOTTOM else Gravity.TOP
    lp.setMargins(context.dp(12), if (barBelow) 0 else barInsets.first + context.dp(8), context.dp(12), if (barBelow) barInsets.second + context.dp(12) else 0)
    bar.layoutParams = lp
  }

  /** Show what is picked: the box, its handles, and the bar saying what it is. */
  fun show(frame: RectF, words: String, canSmaller: Boolean, canBigger: Boolean, stepping: Boolean = false) {
    val shown = box != null && bar.visibility == VISIBLE
    box = RectF(frame)
    hint.visibility = GONE
    barLabel.text = words
    smaller.isEnabled = canSmaller
    smaller.alpha = if (canSmaller) 1f else 0.4f
    bigger.isEnabled = canBigger
    bigger.alpha = if (canBigger) 1f else 0.4f
    // The bar sits at the top or the bottom, away from what is picked. While stepping with
    // Smaller and Bigger it stays where it is, so the next tap finds Bigger again instead of the app.
    if (!stepping || !shown) barBelow = frame.centerY() < height / 2f
    placeBar()
    bar.visibility = if (marking) GONE else VISIBLE
    bar.announceForAccessibility(words)
    invalidate()
  }

  fun clear() {
    box = null
    bar.visibility = GONE
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val b = box ?: return
    val r = context.dp(4).toFloat()
    val outer = RectF(b.left - 3, b.top - 3, b.right + 3, b.bottom + 3)
    canvas.drawRoundRect(outer, r, r, tint)
    canvas.drawRoundRect(outer, r, r, stroke)
    if (marking) return
    val k = context.dp(9).toFloat()
    for ((x, y) in corners(outer)) {
      canvas.drawCircle(x, y + 1, k + 1, shadow)
      canvas.drawCircle(x, y, k, knob)
      canvas.drawCircle(x, y, k, knobRing)
    }
  }

  private fun corners(b: RectF) = listOf(b.left to b.top, b.right to b.top, b.left to b.bottom, b.right to b.bottom)

  // Touch: a tap picks, a corner frames, the inside moves the box.

  private enum class Drag { NONE, TAP, CORNER, MOVE }
  private var drag = Drag.NONE
  private var corner = 0
  private var downX = 0f
  private var downY = 0f
  private var start = RectF()
  private val slop = ViewConfiguration.get(context).scaledTouchSlop

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(e: MotionEvent): Boolean {
    if (marking) return false
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = e.x
        downY = e.y
        val b = box
        drag = Drag.TAP
        if (b != null) {
          val outer = RectF(b.left - 3, b.top - 3, b.right + 3, b.bottom + 3)
          // A dot to see, in a larger area to grab.
          val grab = context.dp(24).toFloat()
          val hit = corners(outer).indexOfFirst { (x, y) -> hypot(e.x - x, e.y - y) <= grab }
          if (hit >= 0) {
            drag = Drag.CORNER
            corner = hit
          } else if (b.contains(e.x, e.y)) {
            drag = Drag.MOVE
          }
          start = RectF(b)
        }
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = e.x - downX
        val dy = e.y - downY
        if (drag == Drag.MOVE && abs(dx) < slop && abs(dy) < slop) return true
        when (drag) {
          Drag.CORNER -> resize(dx, dy, false)
          Drag.MOVE -> move(dx, dy, false)
          else -> {}
        }
      }
      MotionEvent.ACTION_UP -> {
        val dx = e.x - downX
        val dy = e.y - downY
        val still = abs(dx) < slop && abs(dy) < slop
        when {
          drag == Drag.CORNER -> resize(dx, dy, true)
          drag == Drag.MOVE && !still -> move(dx, dy, true)
          still -> {
            performClick()
            events.tapped(e.x, e.y)
          }
        }
        drag = Drag.NONE
      }
      MotionEvent.ACTION_CANCEL -> drag = Drag.NONE
    }
    return true
  }

  override fun performClick(): Boolean = super.performClick()

  /** A corner dragged: the opposite corner stays where it is. */
  private fun resize(dx: Float, dy: Float, done: Boolean) {
    val smallest = context.dp(28).toFloat()
    var l = start.left
    var t = start.top
    var r = start.right
    var b = start.bottom
    if (corner % 2 == 0) l = min(start.left + dx, r - smallest) else r = max(start.right + dx, l + smallest)
    if (corner < 2) t = min(start.top + dy, b - smallest) else b = max(start.bottom + dy, t + smallest)
    val next = RectF(max(0f, l), max(0f, t), min(width.toFloat(), r), min(height.toFloat(), b))
    box = next
    invalidate()
    events.framed(next, done)
  }

  /** The inside of the box dragged: the box moves as it is. */
  private fun move(dx: Float, dy: Float, done: Boolean) {
    val next = RectF(start)
    next.offset(dx, dy)
    next.offset(max(0f, -next.left) - max(0f, next.right - width), max(0f, -next.top) - max(0f, next.bottom - height))
    box = next
    invalidate()
    events.framed(next, done)
  }

  init {
    // Nothing behind the bar is picked through it.
    bar.setOnTouchListener { _, _ -> true }
    hint.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
  }
}
