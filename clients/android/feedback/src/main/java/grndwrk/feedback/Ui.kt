package grndwrk.feedback

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.text.TextUtils
import android.os.Build
import android.view.WindowInsets
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Sizes in dp, as Android asks for anything a finger taps (48dp). */
internal fun Context.dp(v: Number): Int = (v.toFloat() * resources.displayMetrics.density + 0.5f).toInt()

internal object Colors {
  val blue = 0xFF0D99FF.toInt()
  val dark = 0xFF2B2B2B.toInt()
  val light = 0xFFE8E8E8.toInt()
  val green = 0xFF34C759.toInt()
  val yellow = 0xFFFFCC00.toInt()
  val orange = 0xFFFF9500.toInt()
  val red = 0xFFFF3B30.toInt()
  val gray = 0xFF8E8E93.toInt()
  val link = 0xFF007AFF.toInt()

  fun alpha(color: Int, a: Float): Int = Color.argb((a * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))
}

/** The colors of the sheets and the list: light or dark, as the phone is set. */
internal class Palette(context: Context) {
  val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
  val background = if (night) 0xFF000000.toInt() else 0xFFF2F2F7.toInt()
  val card = if (night) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt()
  val text = if (night) 0xFFF2F2F2.toInt() else 0xFF111111.toInt()
  val secondary = if (night) 0xFF9A9AA0.toInt() else 0xFF6B6B70.toInt()
  val field = if (night) 0xFF2C2C2E.toInt() else 0xFFEDEDF0.toInt()
  val line = if (night) 0x33FFFFFF else 0x22000000
  val dialogTheme = if (night) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert
}

internal fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = 0): GradientDrawable = GradientDrawable().apply {
  setColor(color)
  cornerRadius = radius
  if (stroke > 0) setStroke(stroke, strokeColor)
}

internal fun circle(color: Int): GradientDrawable = GradientDrawable().apply {
  shape = GradientDrawable.OVAL
  setColor(color)
}

/** The few icons the button and the sheets need, drawn on a 24 by 24 grid, so the package needs no resources. */
internal enum class Glyph { BUBBLE, TEST, CAMERA, GLOBE, OFFLINE, CLOSE, SMALLER, BIGGER, MIC, STOP, MAC, UP, DOWN, BACK, NEXT, PLAY, TRASH, CHECK, SEND, TRAY, MORE, REFRESH, BEAKER, SPARKLE, CLOCK }

internal class Icon(private val glyph: Glyph, var color: Int, private val size: Int) : Drawable() {
  private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }

  override fun getIntrinsicWidth() = size
  override fun getIntrinsicHeight() = size
  override fun setAlpha(alpha: Int) { p.alpha = alpha }
  override fun setColorFilter(colorFilter: ColorFilter?) { p.colorFilter = colorFilter }
  @Deprecated("Deprecated in Java")
  override fun getOpacity() = PixelFormat.TRANSLUCENT

  private fun path(vararg xy: Float, close: Boolean = false) = Path().apply {
    moveTo(xy[0], xy[1])
    var i = 2
    while (i < xy.size) { lineTo(xy[i], xy[i + 1]); i += 2 }
    if (close) close()
  }

  override fun draw(c: Canvas) {
    val b = bounds
    val s = minOf(b.width(), b.height()) / 24f
    c.save()
    c.translate(b.left + (b.width() - 24 * s) / 2, b.top + (b.height() - 24 * s) / 2)
    c.scale(s, s)
    p.color = color
    p.style = Paint.Style.STROKE
    p.strokeWidth = 2f
    when (glyph) {
      Glyph.BUBBLE -> {
        c.drawRoundRect(RectF(3f, 4f, 21f, 17f), 4f, 4f, p)
        c.drawPath(path(8f, 17f, 7f, 21f, 12.5f, 17f), p)
        c.drawLine(8f, 9f, 16f, 9f, p)
        c.drawLine(8f, 12.5f, 13f, 12.5f, p)
      }
      Glyph.TEST -> {
        c.drawCircle(12f, 12f, 9f, p)
        c.drawPath(path(8f, 12.5f, 11f, 15.5f, 16.5f, 9f), p)
      }
      Glyph.CHECK -> c.drawPath(path(5f, 12.5f, 10f, 17.5f, 19f, 7f), p)
      Glyph.CLOSE -> {
        c.drawLine(6f, 6f, 18f, 18f, p)
        c.drawLine(18f, 6f, 6f, 18f, p)
      }
      Glyph.CAMERA -> {
        p.style = Paint.Style.FILL
        c.drawPath(path(8f, 7f, 9.5f, 4.5f, 14.5f, 4.5f, 16f, 7f, close = true), p)
        c.drawRoundRect(RectF(3f, 7f, 21f, 19f), 3f, 3f, p)
        p.color = Colors.blue
        c.drawCircle(12f, 13f, 3.5f, p)
      }
      Glyph.GLOBE -> {
        c.drawCircle(12f, 12f, 9f, p)
        c.drawOval(RectF(8f, 3f, 16f, 21f), p)
        c.drawLine(3f, 12f, 21f, 12f, p)
      }
      Glyph.OFFLINE -> {
        c.drawArc(RectF(2f, 7f, 22f, 27f), 225f, 90f, false, p)
        c.drawArc(RectF(6f, 11f, 18f, 23f), 225f, 90f, false, p)
        p.style = Paint.Style.FILL
        c.drawCircle(12f, 18.5f, 1.6f, p)
        p.style = Paint.Style.STROKE
        c.drawLine(4f, 4f, 20f, 20f, p)
      }
      Glyph.SMALLER -> {
        c.drawLine(4f, 4f, 10f, 10f, p)
        c.drawPath(path(10f, 5.5f, 10f, 10f, 5.5f, 10f), p)
        c.drawLine(20f, 20f, 14f, 14f, p)
        c.drawPath(path(14f, 18.5f, 14f, 14f, 18.5f, 14f), p)
      }
      Glyph.BIGGER -> {
        c.drawLine(10f, 10f, 4f, 4f, p)
        c.drawPath(path(4f, 8.5f, 4f, 4f, 8.5f, 4f), p)
        c.drawLine(14f, 14f, 20f, 20f, p)
        c.drawPath(path(20f, 15.5f, 20f, 20f, 15.5f, 20f), p)
      }
      Glyph.MIC -> {
        c.drawRoundRect(RectF(9f, 3f, 15f, 14f), 3f, 3f, p)
        c.drawArc(RectF(5.5f, 7f, 18.5f, 18f), 0f, 180f, false, p)
        c.drawLine(12f, 18f, 12f, 21f, p)
      }
      Glyph.STOP -> {
        p.style = Paint.Style.FILL
        c.drawRoundRect(RectF(6f, 6f, 18f, 18f), 2.5f, 2.5f, p)
      }
      Glyph.MAC -> {
        c.drawRoundRect(RectF(4.5f, 5f, 19.5f, 16f), 1.5f, 1.5f, p)
        c.drawLine(2f, 19.5f, 22f, 19.5f, p)
      }
      Glyph.UP -> c.drawPath(path(6f, 15f, 12f, 9f, 18f, 15f), p)
      Glyph.DOWN -> c.drawPath(path(6f, 9f, 12f, 15f, 18f, 9f), p)
      Glyph.BACK -> c.drawPath(path(15f, 5f, 8f, 12f, 15f, 19f), p)
      Glyph.NEXT -> c.drawPath(path(9f, 5f, 16f, 12f, 9f, 19f), p)
      Glyph.PLAY -> {
        c.drawCircle(12f, 12f, 9f, p)
        p.style = Paint.Style.FILL
        c.drawPath(path(10f, 8f, 16f, 12f, 10f, 16f, close = true), p)
      }
      Glyph.TRASH -> {
        c.drawLine(4f, 7f, 20f, 7f, p)
        c.drawPath(path(9f, 7f, 9f, 4f, 15f, 4f, 15f, 7f), p)
        c.drawPath(path(6f, 7f, 7f, 20f, 17f, 20f, 18f, 7f), p)
      }
      Glyph.SEND -> {
        c.drawPath(path(3f, 11f, 21f, 3f, 13f, 21f, 11f, 13f, close = true), p)
        c.drawLine(11f, 13f, 21f, 3f, p)
      }
      Glyph.TRAY -> {
        c.drawPath(path(3f, 13f, 3f, 20f, 21f, 20f, 21f, 13f), p)
        c.drawPath(path(3f, 13f, 8f, 13f, 9f, 16f, 15f, 16f, 16f, 13f, 21f, 13f), p)
        c.drawLine(12f, 3f, 12f, 11f, p)
        c.drawPath(path(8.5f, 6.5f, 12f, 3f, 15.5f, 6.5f), p)
      }
      Glyph.MORE -> {
        p.style = Paint.Style.FILL
        for (x in listOf(6f, 12f, 18f)) c.drawCircle(x, 12f, 1.8f, p)
      }
      Glyph.REFRESH -> {
        c.drawArc(RectF(5f, 5f, 19f, 19f), 40f, 290f, false, p)
        c.drawPath(path(19.5f, 4.5f, 19f, 9.5f, 14f, 9f), p)
      }
      // A test that ran: a beaker.
      Glyph.BEAKER -> {
        c.drawLine(7.5f, 3f, 16.5f, 3f, p)
        c.drawPath(path(9.5f, 3f, 9.5f, 9.5f, 4.5f, 19f, 6f, 21f, 18f, 21f, 19.5f, 19f, 14.5f, 9.5f, 14.5f, 3f), p)
        c.drawLine(6.8f, 15f, 17.2f, 15f, p)
      }
      // The agent tried it: a sparkle.
      Glyph.SPARKLE -> c.drawPath(path(12f, 3f, 14f, 10f, 21f, 12f, 14f, 14f, 12f, 21f, 10f, 14f, 3f, 12f, 10f, 10f, close = true), p)
      // Out of date: a clock.
      Glyph.CLOCK -> {
        c.drawCircle(12f, 12f, 9f, p)
        c.drawPath(path(12f, 7f, 12f, 12f, 15.5f, 12f), p)
      }
    }
    c.restore()
  }
}

internal fun Context.label(text: String, sp: Float, color: Int, bold: Boolean = false, lines: Int = 0): TextView = TextView(this).apply {
  this.text = text
  textSize = sp
  setTextColor(color)
  if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
  if (lines > 0) {
    maxLines = lines
    ellipsize = TextUtils.TruncateAt.END
  }
}

/** A tappable capsule with an optional icon: at least 48dp high, labelled for TalkBack by its words. */
internal fun Context.pill(
  title: String?,
  glyph: Glyph?,
  fill: Int,
  foreground: Int,
  description: String? = null,
  sp: Float = 15f,
  onClick: () -> Unit,
): TextView = TextView(this).apply {
  text = title ?: ""
  textSize = sp
  setTextColor(foreground)
  setTypeface(typeface, android.graphics.Typeface.BOLD)
  gravity = Gravity.CENTER
  minHeight = dp(48)
  minWidth = dp(48)
  val h = if (title.isNullOrEmpty()) dp(12) else dp(16)
  setPadding(h, dp(10), h, dp(10))
  if (glyph != null) {
    val icon = Icon(glyph, foreground, dp(18))
    icon.setBounds(0, 0, dp(18), dp(18))
    setCompoundDrawables(icon, null, null, null)
    compoundDrawablePadding = if (title.isNullOrEmpty()) 0 else dp(6)
  }
  background = rounded(fill, dp(24).toFloat())
  contentDescription = description ?: title
  isClickable = true
  isFocusable = true
  setOnClickListener { onClick() }
}

/** Change a pill's colors in place. */
internal fun TextView.recolor(background: Int, foreground: Int) {
  setTextColor(foreground)
  (this.background as? GradientDrawable)?.setColor(background)
  compoundDrawables.forEach { (it as? Icon)?.color = foreground; it?.invalidateSelf() }
}

internal fun vertical(context: Context, spacing: Int = 0, vararg views: View): LinearLayout = LinearLayout(context).apply {
  orientation = LinearLayout.VERTICAL
  views.forEachIndexed { i, v ->
    addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (i > 0) topMargin = spacing })
  }
}

internal fun horizontal(context: Context, spacing: Int = 0, vararg views: View): LinearLayout = LinearLayout(context).apply {
  orientation = LinearLayout.HORIZONTAL
  gravity = Gravity.CENTER_VERTICAL
  views.forEachIndexed { i, v ->
    // A child that says how it fits (fill(), spacer()) keeps that; the rest wrap their content.
    val lp = (v.layoutParams as? LinearLayout.LayoutParams) ?: LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    if (i > 0) lp.marginStart = spacing
    addView(v, lp)
  }
}

/** Space that takes what is left in a row. */
internal fun spacer(context: Context): View = View(context).apply {
  layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
}

/** A row's child that takes what is left of the width. */
internal fun View.fill(): View = apply { layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f) }

/** A scroll view that never grows past a height. */
internal class MaxHeightScroll(context: Context, var maxHeight: Int) : ScrollView(context) {
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST))
  }
}

/** Buttons for an alert, in the order Android places them: the main one, the other, and cancel. */
internal class Choice(val title: String, val run: (String) -> Unit)

/**
 * A plain alert, with a text field when `field` is given (its hint and its first text):
 * up to three buttons, as UIAlertController does on iOS.
 */
internal fun alert(
  activity: Activity,
  title: String,
  message: String?,
  positive: Choice?,
  neutral: Choice? = null,
  negative: String? = "Cancel",
  field: Pair<String, String>? = null,
  code: Boolean = false,
  onCancel: () -> Unit = {},
): AlertDialog? {
  if (activity.isFinishing || activity.isDestroyed) return null
  val palette = Palette(activity)
  val input = field?.let { (hint, start) ->
    EditText(activity).apply {
      this.hint = hint
      setText(start)
      setSelection(text.length)
      inputType = if (code) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      contentDescription = title
    }
  }
  val builder = AlertDialog.Builder(activity, palette.dialogTheme).setTitle(title)
  if (message != null) builder.setMessage(message)
  if (input != null) {
    val box = FrameLayout(activity).apply { setPadding(activity.dp(20), activity.dp(4), activity.dp(20), 0) }
    box.addView(input)
    builder.setView(box)
  }
  val text = { input?.text?.toString() ?: "" }
  positive?.let { c -> builder.setPositiveButton(c.title) { _, _ -> c.run(text()) } }
  neutral?.let { c -> builder.setNeutralButton(c.title) { _, _ -> c.run(text()) } }
  negative?.let { builder.setNegativeButton(it) { _, _ -> onCancel() } }
  builder.setOnCancelListener { onCancel() }
  val dialog = builder.create()
  if (input != null) dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
  Overlay.track(dialog)
  dialog.show()
  return dialog
}

/**
 * A sheet with a text field, kept clear of the keyboard. From Android 15, an app that
 * targets 35 or later is drawn edge to edge and SOFT_INPUT_ADJUST_RESIZE no longer moves a
 * dialog, so its bottom padding follows what the keyboard and the bars take instead. With a
 * hardware keyboard there is no keyboard on screen, only Gboard's small floating toolbar,
 * which takes no room and floats about two thirds down, right over a sheet at the bottom:
 * then the sheet goes to the top of the screen.
 */
internal fun Dialog.keepAboveKeyboard(context: Context, side: Int, gap: Int) {
  val w = window ?: return
  val hardware = context.resources.configuration.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
  w.setGravity(if (hardware) Gravity.TOP else Gravity.BOTTOM)
  if (Build.VERSION.SDK_INT < 30) {
    w.decorView.setPadding(side, if (hardware) gap else 0, side, gap)
    return
  }
  w.setDecorFitsSystemWindows(false)
  w.decorView.setOnApplyWindowInsetsListener { v, insets ->
    val ime = insets.getInsets(WindowInsets.Type.ime()).bottom
    val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
    v.setPadding(side + bars.left, bars.top + (if (hardware) gap else 0), side + bars.right, maxOf(ime, bars.bottom) + gap)
    WindowInsets.CONSUMED
  }
}

/**
 * A list of actions under a title and a message, at the bottom of the screen,
 * as an action sheet on iOS. The message can be changed while it shows.
 */
internal class Choices(private val activity: Activity, title: String, message: String) {
  private val palette = Palette(activity)
  private val dialog = Dialog(activity)
  private val list = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
  val messageView: TextView = activity.label(message, 13f, palette.secondary)

  init {
    val pad = activity.dp(20)
    val head = vertical(activity, activity.dp(6), activity.label(title, 17f, palette.text, bold = true), messageView)
    head.setPadding(pad, pad, pad, activity.dp(12))
    messageView.visibility = if (message.isEmpty()) View.GONE else View.VISIBLE
    val all = vertical(activity, 0, head, list)
    all.background = rounded(palette.card, activity.dp(20).toFloat())
    val scroll = MaxHeightScroll(activity, (activity.resources.displayMetrics.heightPixels * 0.85).toInt())
    scroll.addView(all)
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
    dialog.setContentView(scroll)
    dialog.window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setGravity(Gravity.BOTTOM)
      setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      decorView.setPadding(activity.dp(8), 0, activity.dp(8), activity.dp(8))
    }
  }

  fun setMessage(text: String) {
    messageView.text = text
    messageView.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
  }

  val showing: Boolean get() = dialog.isShowing

  fun add(title: String, destructive: Boolean = false, run: () -> Unit): Choices {
    val row = activity.label(title, 17f, if (destructive) Colors.red else Colors.link).apply {
      gravity = Gravity.CENTER
      minHeight = activity.dp(52)
      setPadding(activity.dp(16), activity.dp(12), activity.dp(16), activity.dp(12))
      isClickable = true
      isFocusable = true
      contentDescription = title
      setOnClickListener {
        dialog.dismiss()
        run()
      }
    }
    list.addView(View(activity).apply { setBackgroundColor(palette.line) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
    list.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    return this
  }

  fun show() {
    if (activity.isFinishing || activity.isDestroyed) return
    add("Cancel") {}
    (list.getChildAt(list.childCount - 1) as TextView).setTypeface(null, android.graphics.Typeface.BOLD)
    Overlay.track(dialog)
    dialog.show()
  }
}
