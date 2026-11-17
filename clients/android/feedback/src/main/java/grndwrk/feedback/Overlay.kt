package grndwrk.feedback

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.launch
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * The grndwrk button over the app, and everything it opens: picking what to
 * comment on, the comment sheet, the long-press menu, the list of comments,
 * and the card for testing a fix. Each part is a small window of its own
 * above the activity's (a panel on the activity's token), so a picture of the
 * app never shows any of it, and touches elsewhere go to the app.
 */
@SuppressLint("StaticFieldLeak")
internal object Overlay {
  private var ref: WeakReference<Activity>? = null
  private val activity: Activity? get() = ref?.get()
  private var wm: WindowManager? = null
  private var attached = false
  private var subs = listOf<() -> Unit>()
  private var layoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null

  // The button: a capsule reading grndwrk, with the test part on its right when fixes are ready.
  private var buttonRoot: DragFrame? = null
  private var buttonParams: WindowManager.LayoutParams? = null
  private lateinit var main: TextView
  private lateinit var divider: View
  private lateinit var testPart: TextView
  private lateinit var dot: View
  private lateinit var camera: View
  /** Where the button's right edge and top sit in the activity's window, kept from one screen to the next. */
  private var right = -1
  private var top = -1

  // Tucked away at a side.
  enum class Side { LEFT, RIGHT }
  /** The side the button is tucked into, or null when it is out. */
  private var stashed: Side? = null
  private var tab: DragFrame? = null
  private var tabParams: WindowManager.LayoutParams? = null

  // Picking.
  var picking = false
    private set
  private var layer: PickLayer? = null
  private var layerParams: WindowManager.LayoutParams? = null
  private var candidates: List<Inspector.Found> = emptyList()
  private var chosen = 0
  /** An area the person framed with the handles: wins over the candidates until smaller or bigger is used. */
  private var custom: Inspector.Found? = null
  private val picked: Inspector.Found? get() = custom ?: candidates.getOrNull(chosen)
  /** The comment sheet is open: no pictures of the screen meanwhile. */
  private var composing = false

  // Testing a fix.
  var testing: Outbox.Item? = null
    private set
  private var card: DragFrame? = null
  private var cardParams: WindowManager.LayoutParams? = null
  private var cardOffset = -1
  private var cardOpen = true
  /** Each step of the fix being tested, marked works (true) or not (false) by the person. */
  private var stepMarks = mutableMapOf<Int, Boolean>()
  private var testOpened = false

  // Messages and the keyboard.
  private var toast: TextView? = null
  private var toastText: String? = null
  /** Where the app's keyboard begins, in the activity's window, while one is up. */
  private var keyboardTop: Int? = null
  /** Where the button stood before a keyboard pushed it up, to go back to when it closes. */
  private var beforeKeyboard: Int? = null
  private var dialogs = 0
  private var pairing = false
  private val ticker = object : Runnable {
    override fun run() {
      val a = activity ?: return
      if (!attached) return
      Snapshots.tick(a, busy = picking || composing || dialogs > 0)
      checkKeyboard()
      Env.main.postDelayed(this, 1000)
    }
  }

  // Windows

  fun attach(activity: Activity) {
    if (attached && this.activity === activity) return
    this.activity?.let { if (it !== activity) detach(it) }
    ref = WeakReference(activity)
    val decor = activity.window?.decorView ?: return
    if (decor.isAttachedToWindow && decor.windowToken != null) {
      addWindows(activity)
    } else {
      decor.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) {
          v.removeOnAttachStateChangeListener(this)
          // Still the one in front: float over it now that it has a window.
          v.post { if (this@Overlay.activity === activity && !attached && !activity.isFinishing) addWindows(activity) }
        }
        override fun onViewDetachedFromWindow(v: View) {}
      })
    }
  }

  fun detach(activity: Activity) {
    if (this.activity !== activity) return
    if (picking) setPicking(false)
    removeWindows()
    ref = null
  }

  private fun params(a: Activity, type: Int, w: Int, h: Int, flags: Int) = WindowManager.LayoutParams(w, h, type, flags, PixelFormat.TRANSLUCENT).apply {
    token = a.window.decorView.windowToken
    gravity = Gravity.TOP or Gravity.START
    title = "grndwrk"
    if (Build.VERSION.SDK_INT >= 28) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
  }

  private val floating = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS

  private fun addWindows(a: Activity) {
    wm = a.windowManager
    attached = true
    buildButton(a)
    val root = buttonRoot!!
    root.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    val (w, h) = size()
    val safe = safe()
    if (right < 0 || right > w + root.measuredWidth || top > h) {
      right = w - a.dp(16) + a.dp(8)
      top = h - safe.bottom - root.measuredHeight - a.dp(24) + a.dp(8)
    }
    val p = params(a, WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, floating)
    p.x = right - root.measuredWidth
    p.y = top
    buttonParams = p
    add(root, p)
    // Grow or shrink to the left, keeping the button where the person put it.
    root.addOnLayoutChangeListener { v, l, _, r, _, _, _, _, _ ->
      val bp = buttonParams ?: return@addOnLayoutChangeListener
      if (stashed == null && r - l != 0 && bp.x + (r - l) != right) {
        bp.x = right - (r - l)
        update(v, bp)
      }
    }
    if (stashed != null) stash(stashed!!, animate = false)
    subscribe()
    val decor = a.window.decorView
    layoutListener = ViewTreeObserver.OnGlobalLayoutListener { checkKeyboard() }
    decor.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
    updateBadge()
    testing?.let { buildCard(it, testOpened) }
    Env.main.removeCallbacks(ticker)
    Env.main.postDelayed(ticker, 1000)
  }

  private fun removeWindows() {
    attached = false
    Env.main.removeCallbacks(ticker)
    subs.forEach { it() }
    subs = emptyList()
    activity?.window?.decorView?.viewTreeObserver?.let { o -> layoutListener?.let { if (o.isAlive) o.removeOnGlobalLayoutListener(it) } }
    layoutListener = null
    for (v in listOf<View?>(buttonRoot, tab, card, toast, layer)) remove(v)
    buttonRoot = null
    tab = null
    card = null
    toast = null
    layer = null
  }

  private fun add(v: View, p: WindowManager.LayoutParams) {
    try { wm?.addView(v, p) } catch (e: Exception) { gwLog.error("Could not show the grndwrk button: ${e.message}") }
  }

  private fun update(v: View?, p: WindowManager.LayoutParams?) {
    if (v == null || p == null || !v.isAttachedToWindow) return
    try { wm?.updateViewLayout(v, p) } catch (_: Exception) {}
  }

  private fun remove(v: View?) {
    if (v == null || !v.isAttachedToWindow) return
    try { wm?.removeViewImmediate(v) } catch (_: Exception) {}
  }

  /** The activity's window size. */
  private fun size(): Pair<Int, Int> {
    val d = activity?.window?.decorView ?: return 0 to 0
    return d.width to d.height
  }

  /** Room the system bars and cutouts take, in the activity's window. */
  private fun safe(): Rect {
    val i = activity?.window?.decorView?.rootWindowInsets ?: return Rect()
    return if (Build.VERSION.SDK_INT >= 30) {
      val t = i.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
      Rect(t.left, t.top, t.right, t.bottom)
    } else {
      @Suppress("DEPRECATION")
      Rect(i.stableInsetLeft, i.stableInsetTop, i.stableInsetRight, i.stableInsetBottom)
    }
  }

  /** The top of the keyboard in the activity's window, or null while none is up. */
  private fun imeTop(): Int? {
    val decor = activity?.window?.decorView ?: return null
    val i = decor.rootWindowInsets ?: return null
    val bottom = if (Build.VERSION.SDK_INT >= 30) i.getInsets(WindowInsets.Type.ime()).bottom
    else @Suppress("DEPRECATION") (i.systemWindowInsetBottom - i.stableInsetBottom).takeIf { it > decor.context.dp(80) }?.plus(i.stableInsetBottom) ?: 0
    return if (bottom > 0) decor.height - bottom else null
  }

  /** The lowest point anything of grndwrk's may reach: above the system bars, or the top of the keyboard. */
  private fun floorY(): Int {
    val (_, h) = size()
    return min(h - safe().bottom, keyboardTop ?: Int.MAX_VALUE)
  }

  private fun subscribe() {
    subs = listOf(
      Bus.on(Bus.CONNECTION) { info -> connectionChanged(info["before"] as? Connection.State) },
      Bus.on(Bus.OUTBOX) { updateBadge() },
      Bus.on(Bus.RELAY) { updateBadge() },
      Bus.on(Bus.STORE) { updateBadge() },
      Bus.on(Bus.NEW_FIXES) { info ->
        val count = info["count"] as? Int ?: 0
        flash(if (count == 1) "A fix is ready to test" else "$count fixes are ready to test")
        updateBadge()
      },
      Bus.on(Bus.TOOK_PICTURE) { blinkCamera() },
    )
  }

  /** A dialog of grndwrk's is up: the app is busy, so no picture of the screen is taken meanwhile. */
  fun track(dialog: Dialog, onDismiss: (() -> Unit)? = null) {
    dialogs++
    dialog.setOnDismissListener {
      dialogs = max(0, dialogs - 1)
      onDismiss?.invoke()
    }
  }

  // The button

  private fun buildButton(a: Activity) {
    val root = DragFrame(a, vertical = false)
    root.setPadding(a.dp(8), a.dp(8), a.dp(8), a.dp(8))
    root.clipToPadding = false
    root.clipChildren = false
    val capsule = LinearLayout(a).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      background = rounded(Colors.dark, a.dp(24).toFloat())
      elevation = a.dp(6).toFloat()
    }
    main = a.pill("grndwrk", Glyph.BUBBLE, Color.TRANSPARENT, Colors.light) { togglePicking() }
    main.background = null
    main.setOnLongClickListener {
      menu()
      true
    }
    main.tag = "grndwrk-comment"
    divider = View(a).apply { setBackgroundColor(0x40FFFFFF) }
    // The right part of the same capsule: the test icon and how many.
    testPart = a.pill("0", Glyph.TEST, Color.TRANSPARENT, Colors.light) {
      // One fix: straight to testing it. More: the list to choose from.
      val ready = Outbox.toTest
      if (ready.size == 1) startTesting(ready[0]) else showComments(CommentsList.Mode.TO_TEST)
    }
    testPart.background = null
    testPart.setPadding(a.dp(12), a.dp(10), a.dp(16), a.dp(10))
    capsule.addView(main)
    capsule.addView(divider, LinearLayout.LayoutParams(a.dp(1), a.dp(22)))
    capsule.addView(testPart)
    root.addView(capsule, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    // Green when grndwrk answers, orange when comments wait on the phone.
    dot = View(a).apply {
      background = circle(Colors.gray).apply { setStroke(a.dp(1.5f), Colors.dark) }
      elevation = a.dp(7).toFloat()
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    root.addView(dot, FrameLayout.LayoutParams(a.dp(10), a.dp(10), Gravity.TOP or Gravity.END).apply { topMargin = a.dp(1); marginEnd = a.dp(2) })
    // Shown on the button for a moment when a picture of the screen was taken.
    camera = View(a).apply {
      background = circle(Colors.blue)
      foreground = Icon(Glyph.CAMERA, 0xFFFFFFFF.toInt(), a.dp(12)).also { it.setBounds(a.dp(3), a.dp(3), a.dp(15), a.dp(15)) }
      alpha = 0f
      elevation = a.dp(7).toFloat()
      contentDescription = "Picture taken"
    }
    root.addView(camera, FrameLayout.LayoutParams(a.dp(18), a.dp(18), Gravity.TOP or Gravity.START).apply { topMargin = -a.dp(6) + a.dp(8) - a.dp(8); marginStart = -a.dp(4) })
    root.onDrag = { dx, dy -> moveButton(dx, dy) }
    root.onDragEnd = { vx, _ -> dragEnded(vx) }
    buttonRoot = root
  }

  private fun moveButton(dx: Float, dy: Float) {
    val p = buttonParams ?: return
    p.x += dx.toInt()
    p.y += dy.toInt()
    update(buttonRoot, p)
  }

  private fun dragEnded(speed: Float) {
    val root = buttonRoot ?: return
    val p = buttonParams ?: return
    val a = activity ?: return
    val (w, _) = size()
    val pad = a.dp(8)
    val bw = root.width - 2 * pad
    val left = p.x + pad
    val rightEdge = left + bw
    val mid = left + bw / 2
    // Flicked or pushed against a side: tuck it away there, like a video in picture in picture.
    if (rightEdge > w + bw * 0.25 || (speed > a.dp(900) && mid > w / 2)) return stash(Side.RIGHT)
    if (left < -bw * 0.25 || (speed < -a.dp(900) && mid < w / 2)) return stash(Side.LEFT)
    // Back fully on the screen.
    val safe = safe()
    val x = max(a.dp(8), min(left, w - bw - a.dp(8))) - pad
    val y = max(safe.top + a.dp(8), min(p.y + pad, floorY() - (root.height - 2 * pad) - a.dp(8))) - pad
    // Put there by the person: where it stays when the keyboard closes.
    beforeKeyboard = null
    animate(p.x, p.y, x, y) {
      right = x + root.width
      top = y
    }
  }

  private fun animate(fromX: Int, fromY: Int, toX: Int, toY: Int, then: () -> Unit = {}) {
    val p = buttonParams ?: return
    ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 200
      interpolator = DecelerateInterpolator()
      addUpdateListener {
        val f = it.animatedValue as Float
        p.x = (fromX + (toX - fromX) * f).toInt()
        p.y = (fromY + (toY - fromY) * f).toInt()
        update(buttonRoot, p)
      }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: android.animation.Animator) { then() }
      })
      start()
    }
  }

  // Tucked away at a side

  private fun stash(side: Side, animate: Boolean = true) {
    val a = activity ?: return
    val root = buttonRoot ?: return
    val p = buttonParams ?: return
    val (w, _) = size()
    val pad = a.dp(8)
    val bh = (if (root.height > 0) root.height else root.measuredHeight)
    val bw = (if (root.width > 0) root.width else root.measuredWidth)
    if (stashed == null) {
      right = p.x + bw
      top = p.y
    }
    stashed = side
    if (right - bw + pad < a.dp(8) || right - pad > w - a.dp(8)) {
      // Thrown from off the screen: come back fully on it, on that side.
      right = if (side == Side.RIGHT) w - a.dp(16) + pad else a.dp(16) - pad + bw
    }
    top = min(max(p.y, safe().top + a.dp(8) - pad), floorY() - bh + pad - a.dp(8))
    updateBadge()
    // A tab half off the edge, wide enough to grab.
    showTab(side, top + bh / 2)
    val toX = if (side == Side.RIGHT) w + a.dp(12) else -bw - a.dp(12)
    if (animate) animate(p.x, p.y, toX, top) else {
      p.x = toX
      p.y = top
      update(root, p)
    }
  }

  private fun showTab(side: Side, centerY: Int) {
    val a = activity ?: return
    remove(tab)
    val t = DragFrame(a, vertical = false)
    t.background = rounded(Colors.dark, a.dp(10).toFloat())
    t.elevation = a.dp(4).toFloat()
    t.contentDescription = "grndwrk. Brings the grndwrk button back"
    t.isClickable = true
    t.isFocusable = true
    val line = View(a).apply { background = rounded(0x99FFFFFF.toInt(), a.dp(2).toFloat()) }
    t.addView(line, FrameLayout.LayoutParams(a.dp(4), a.dp(28), Gravity.CENTER_VERTICAL or (if (side == Side.RIGHT) Gravity.START else Gravity.END)).apply {
      if (side == Side.RIGHT) marginStart = a.dp(7) else marginEnd = a.dp(7)
    })
    t.setOnClickListener { unstash() }
    // Pulling the tab away from the edge brings the button out.
    var pulled = 0f
    t.onDrag = { dx, _ ->
      pulled += if (side == Side.RIGHT) -dx else dx
      if (pulled > a.dp(24)) {
        pulled = -10000f
        unstash()
      }
    }
    t.onDragEnd = { _, _ -> if (pulled >= 0) unstash() }
    val (w, _) = size()
    val p = params(a, WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL, a.dp(28), a.dp(64), floating)
    p.x = if (side == Side.RIGHT) w - a.dp(18) else -a.dp(10)
    p.y = centerY - a.dp(32)
    tab = t
    tabParams = p
    add(t, p)
  }

  private fun unstash() {
    if (stashed == null) return
    stashed = null
    remove(tab)
    tab = null
    val root = buttonRoot ?: return
    val p = buttonParams ?: return
    animate(p.x, p.y, right - root.width, top) { updateBadge() }
  }

  // The keyboard

  /** A keyboard opened, moved or closed. The button, its tab and the test card go above it, and the button back down after. */
  private fun checkKeyboard() {
    val now = imeTop()
    if (now == keyboardTop) return
    keyboardTop = now
    val a = activity ?: return
    val root = buttonRoot ?: return
    val p = buttonParams ?: return
    val bh = root.height
    if (now != null) {
      val lowest = now - bh - a.dp(8) + a.dp(8)
      if (top > lowest) {
        if (beforeKeyboard == null) beforeKeyboard = top
        top = lowest
      }
    } else {
      beforeKeyboard?.let { top = it }
      beforeKeyboard = null
    }
    p.y = top
    update(root, p)
    if (stashed != null) tabParams?.let { tp -> tp.y = top + bh / 2 - a.dp(32); update(tab, tp) }
    placeCard()
    toast?.let { t -> (t.layoutParams as? WindowManager.LayoutParams)?.let { tp -> tp.y = toastY(t); update(t, tp) } }
  }

  // Connection

  private fun connectionChanged(before: Connection.State?) {
    updateBadge()
    when (val state = Connection.state) {
      is Connection.State.Connected -> {
        if (before is Connection.State.Connected) return
        flash(if (state.project.isEmpty()) "Connected to grndwrk" else "Connected to grndwrk “${state.project}”")
      }
      is Connection.State.Offline -> {
        // Only say it when it was there a moment ago. The dot says the rest.
        if (before is Connection.State.Connected) {
          flash(
            if (Store.usable) "Away from grndwrk's Wi-Fi. Comments go to your team's store."
            else if (Relay.usable) "Away from grndwrk's Wi-Fi. Comments go through your team's relay."
            else "Lost grndwrk. Comments wait on the phone.",
          )
        }
      }
      is Connection.State.NeedsCode -> {
        // Ask once when it starts wanting to pair, not every time it checks.
        if (before is Connection.State.NeedsCode) return
        // Joined the team's store or relay: comments already go there. Ask which way, rather than asking to be allowed twice.
        if (Relay.joined != null || Store.joined != null) {
          if (!Relay.keepsRelay(state.project)) askWifiOrRelay(state.project)
          return
        }
        pair()
      }
      Connection.State.Unknown -> {}
    }
  }

  /** grndwrk turned up on this Wi-Fi, not paired, while the phone sends through the team's relay: which way from now on? */
  private fun askWifiOrRelay(project: String) {
    val a = activity ?: return
    alert(
      a, "grndwrk is on this Wi-Fi",
      "Comments go to ${Connection.teamWay} now. Pair with grndwrk${if (project.isEmpty()) "" else " “$project”"} on this Wi-Fi instead? It is quicker. Either way, nothing waits.",
      positive = Choice("Pair on the Wi-Fi") {
        Relay.setKeepsRelay(project, false)
        pair()
      },
      negative = null,
      neutral = Choice(if (Store.joined != null) "Keep using the store" else "Keep using the relay") {
        Relay.setKeepsRelay(project, true)
        flash("Comments go to ${Connection.teamWay}. Long press, Pair with the Mac, to change it.")
      },
    )
  }

  /** Ask the person at the Mac to allow this phone. Without the map open on the Mac, or without an answer, ask for the code from the terminal instead. */
  fun pair() {
    val state = Connection.state as? Connection.State.NeedsCode ?: return
    if (pairing) return
    pairing = true
    flash("Asking grndwrk on your Mac")
    Env.scope.launch {
      val asked = Pairing.ask { digits -> flash("Click Allow on your Mac, next to $digits") }
      pairing = false
      when (asked) {
        is Pairing.Asked.Allowed -> confirmPairing(state.project, asked.key, asked.digits)
        Pairing.Asked.Denied -> flash("Not allowed on the Mac. Long press the grndwrk button to ask again.")
        Pairing.Asked.NoBrowser -> askForCode("Open grndwrk in the browser on the Mac to allow this phone, or enter the code it shows in the terminal.")
        Pairing.Asked.Unanswered -> askForCode("Nobody answered on the Mac. Enter the code grndwrk shows in the terminal, or ask again.")
      }
    }
  }

  /** Something on the Wi-Fi could answer as grndwrk and allow at once. Only the person knows whether they clicked Allow on their own Mac. */
  private fun confirmPairing(project: String, key: String, digits: String) {
    val a = activity ?: return
    alert(
      a, "Did you allow it on your Mac?",
      "grndwrk on your Mac showed this phone with the digits $digits. Pair only if you clicked Allow there yourself.",
      positive = Choice("Yes, I allowed $digits") {
        Pairing.save(key, project)
        Env.scope.launch { Connection.check() }
      },
      negative = "No",
      onCancel = {
        gwLog.error("Pairing answered without the person allowing it on their Mac; the key was dropped")
        flash("Not paired. Something else on this Wi-Fi may be posing as grndwrk.")
      },
    )
  }

  /** Ask for the pairing code `grndwrk --lan` prints in the terminal. */
  fun askForCode(message: String? = null, from: Activity? = null) {
    val state = Connection.state as? Connection.State.NeedsCode ?: return
    val a = from ?: activity ?: return
    val project = state.project
    alert(
      a, "Pairing code",
      message ?: "Enter the code grndwrk${if (project.isEmpty()) "" else " “$project”"} shows in the terminal on the Mac. You only need it once.",
      positive = Choice("Pair") { code ->
        Env.scope.launch {
          // The code is sent once, for a key of this phone's own; wrong codes lock out for a while.
          Pairing.pair(code.trim())?.let { Pairing.save(it, project) }
          Connection.check()
          if (Connection.state is Connection.State.NeedsCode) flash("That code did not work. Long press the grndwrk button to try again.")
        }
      },
      neutral = Choice("Ask the Mac") { pair() },
      negative = "Not now",
      field = "ABC234" to "",
      code = true,
    )
  }

  // Menu

  /** Long press: the list of comments, sharing waiting ones as a file (for testers without grndwrk), or hiding the button. */
  private fun menu() {
    val a = activity ?: return
    val count = Outbox.count
    val lines = listOf(
      status(),
      if (Connection.viaStore) "" else Store.status?.let { "$it." } ?: "",
      if (Connection.viaRelay || Store.joined != null) "" else Relay.status?.let { "$it." } ?: "",
      Snapshots.status(a),
    ).filter { it.isNotEmpty() }.toMutableList()
    if (count > 0) lines += "$count ${if (count == 1) "comment waits" else "comments wait"} to be sent."
    val sheet = Choices(a, "grndwrk", lines.joinToString("\n"))
    if (Connection.state is Connection.State.NeedsCode) {
      sheet.add("Pair with the Mac") { pair() }
      sheet.add("Enter pairing code") { askForCode() }
    }
    val fixes = Outbox.toTest.size
    if (fixes > 0) sheet.add(if (fixes == 1) "Test 1 fix" else "Test $fixes fixes") { showComments(CommentsList.Mode.TO_TEST) }
    sheet.add("Show comments") { showComments() }
    if (Snapshots.enabled && Connection.state is Connection.State.Connected) {
      sheet.add("Take a picture of this screen") { Snapshots.takeNow(activity) }
    }
    if (count > 0) sheet.add("Share $count ${if (count == 1) "comment" else "comments"} as a file") { share() }
    Store.joined?.let { store ->
      if (store.refused != null) sheet.add("Join again with a store link") { Join.present(a) { updateBadge() } }
      sheet.add("Leave your team's store") { Join.leaveStore(a) }
    }
    val relay = Relay.joined
    if (relay == null) {
      if (Store.joined == null) sheet.add("Join with a store link or invite") { Join.present(a) { updateBadge() } }
    } else if (relay.refused != null) {
      sheet.add("Show the digits to be allowed") { Join.showDigits(a) }
      sheet.add("Leave the relay") { Join.leaveRelay(a) }
    } else {
      sheet.add("Leave the relay") { Join.leaveRelay(a) }
    }
    sheet.add("Hide the grndwrk button", destructive = true) { confirmHide() }
    sheet.show()
    // What this screen is for and who it is for, from the map, added once grndwrk answers.
    val screen = Inspector.screen(a)
    Env.scope.launch {
      val about = Outbox.screenAbout(screen) ?: return@launch
      if (!sheet.showing) return@launch
      sheet.setMessage(listOf(sheet.messageView.text.toString(), about).filter { it.isNotEmpty() }.joinToString("\n\n"))
    }
  }

  /** The connection in words. */
  fun status(): String = when (val s = Connection.state) {
    is Connection.State.Connected -> "Connected to ${if (s.project.isEmpty()) "grndwrk" else "“${s.project}”"} at ${s.host}."
    is Connection.State.NeedsCode -> {
      val name = if (s.project.isEmpty()) "grndwrk" else "“${s.project}”"
      if (Relay.joined != null || Store.joined != null) "$name at ${s.host} is on this Wi-Fi but not paired. Comments go to ${Connection.teamWay} meanwhile."
      else "$name at ${s.host} needs the pairing code. Comments wait on the phone."
    }
    is Connection.State.Offline -> {
      val relayHost = Relay.joined?.let { try { java.net.URL(it.url).host } catch (_: Exception) { null } }
      when {
        Connection.viaStore -> "Straight to your team's store at ${Store.host}. No grndwrk on this Wi-Fi, so comments go to the store and reach the map when someone on the team runs grndwrk."
        Connection.viaRelay && relayHost != null -> "Through your team's relay at $relayHost. No grndwrk on this Wi-Fi, so comments go to the relay and reach grndwrk when someone on the team runs it."
        else -> "Not connected. ${s.why} Comments wait on the phone."
      }
    }
    Connection.State.Unknown -> "Looking for grndwrk..."
  }

  fun showComments() = showComments(CommentsList.Mode.OVERVIEW)

  fun showComments(list: CommentsList.Mode) {
    val a = activity ?: GrndwrkFeedback.activity ?: return
    CommentsList(a, list).show()
  }

  /** Hiding is until the app is opened again: say so before it is gone. */
  private fun confirmHide() {
    val a = activity ?: return
    alert(
      a, "Hide the grndwrk button?",
      "It stays hidden until the app is opened again: close it in the recent apps and open it, and the button is back. Comments that wait stay on the phone, and no pictures are taken while it is hidden.",
      positive = Choice("Hide") { GrndwrkFeedback.stop() },
    )
  }

  /** A picture of the screen went to grndwrk: the camera on the button shows for a moment. */
  private fun blinkCamera() {
    if (!::camera.isInitialized) return
    camera.animate().alpha(1f).setDuration(150).withEndAction {
      camera.animate().alpha(0f).setStartDelay(1400).setDuration(400).start()
    }.start()
  }

  /**
   * One file with every waiting comment, pictures included. The person who
   * runs grndwrk adds it with `grndwrk import-feedback <file>`.
   */
  fun share(from: Activity? = null, done: (String) -> Unit = { flash(it) }) {
    val a = from ?: activity ?: return
    val (file, sent) = Outbox.export() ?: return
    val uri = shareable(a, file)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = "application/json"
      putExtra(Intent.EXTRA_SUBJECT, file.name)
      if (uri != null) {
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } else {
        putExtra(Intent.EXTRA_TEXT, file.readText())
      }
    }
    if (uri == null && file.length() > 400_000) {
      return done("Too large to share without a file on this phone. They stay here until grndwrk answers.")
    }
    // Shared: they are on their way, so they do not wait here any more. Told when a target was picked.
    val action = "${a.packageName}.grndwrk.shared.${UUID.randomUUID()}"
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        try { context.unregisterReceiver(this) } catch (_: Exception) {}
        Outbox.remove(sent)
        done("Shared. They will show up in grndwrk once imported.")
      }
    }
    val app = a.applicationContext
    if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
    else @Suppress("UnspecifiedRegisterReceiverFlag") app.registerReceiver(receiver, IntentFilter(action))
    val flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) android.app.PendingIntent.FLAG_MUTABLE else 0)
    val pending = android.app.PendingIntent.getBroadcast(app, 0, Intent(action).setPackage(a.packageName), flags)
    a.startActivity(Intent.createChooser(send, "Share comments", pending.intentSender))
  }

  /**
   * A content address another app can read the file at: through the package's
   * own provider when the app has it, else a copy in Downloads (Android 10 and later).
   */
  private fun shareable(a: Activity, file: File): Uri? {
    val authority = "${a.packageName}.grndwrk.share"
    // Only this app's own provider: another app claiming the name would hand out its own content.
    if (a.packageManager.resolveContentProvider(authority, 0)?.packageName == a.packageName) return Uri.parse("content://$authority/${file.name}")
    if (Build.VERSION.SDK_INT < 29) return null
    return try {
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
        put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      }
      val uri = a.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
      a.contentResolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
      uri
    } catch (_: Exception) {
      null
    }
  }

  // Picking

  private fun togglePicking() {
    if (stashed != null) return unstash()
    setPicking(!picking)
  }

  private fun setPicking(on: Boolean) {
    picking = on
    val a = activity
    if (on && a != null) {
      remove(layer)
      val l = PickLayer(a, pickEvents)
      val safe = safe()
      l.inset(safe.top, safe.bottom)
      val p = params(a, WindowManager.LayoutParams.TYPE_APPLICATION_PANEL, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN)
      layer = l
      layerParams = p
      add(l, p)
      l.announceForAccessibility("Tap what you want to comment on")
    } else if (!on) {
      buttonRoot?.visibility = View.VISIBLE
      if (!composing) {
        remove(layer)
        layer = null
      }
      candidates = emptyList()
      custom = null
    }
    updateBadge()
  }

  private val pickEvents = object : PickLayer.Events {
    override fun tapped(x: Float, y: Float) {
      val (wx, wy) = toWindow(x, y)
      select(wx, wy)
    }
    override fun framed(box: RectF, done: Boolean) {
      if (!done) return
      val a = activity ?: return
      // What the area holds, read once the finger lets go.
      val frame = toWindow(box)
      frame.inset(3, 3)
      custom = Inspector.area(a, frame)
      showChosen()
    }
    override fun step(by: Int) { this@Overlay.step(by) }
    override fun close() { setPicking(false) }
    override fun comment() { compose() }
  }

  /** The layer's offset in the activity's window. */
  private fun layerOffset(): Pair<Int, Int> {
    val l = layer ?: return 0 to 0
    val d = activity?.window?.decorView ?: return 0 to 0
    val a = IntArray(2).also { l.getLocationOnScreen(it) }
    val b = IntArray(2).also { d.getLocationOnScreen(it) }
    return (a[0] - b[0]) to (a[1] - b[1])
  }

  private fun toWindow(x: Float, y: Float): Pair<Int, Int> {
    val (ox, oy) = layerOffset()
    return (x + ox).toInt() to (y + oy).toInt()
  }

  private fun toWindow(r: RectF): Rect {
    val (ox, oy) = layerOffset()
    return Rect((r.left + ox).toInt(), (r.top + oy).toInt(), (r.right + ox).toInt(), (r.bottom + oy).toInt())
  }

  private fun toLayer(r: Rect): RectF {
    val (ox, oy) = layerOffset()
    return RectF((r.left - ox).toFloat(), (r.top - oy).toFloat(), (r.right - ox).toFloat(), (r.bottom - oy).toFloat())
  }

  /** Everything under the point, with the smallest element chosen. Point in the activity's window. */
  private fun select(x: Int, y: Int) {
    val a = activity ?: return
    if (!picking) setPicking(true)
    candidates = Inspector.candidates(a, x, y)
    chosen = Inspector.preferred(candidates)
    custom = null
    showChosen()
  }

  private fun step(by: Int) {
    // From a framed area, the arrows go back to the picks under the finger.
    if (custom != null) custom = null else chosen = max(0, min(candidates.size - 1, chosen + by))
    showChosen()
  }

  private fun showChosen() {
    val found = picked ?: return
    val l = layer ?: return
    // Two lines to show it: cut at a word, never in the middle of a " · ".
    val words = found.label?.take(90)?.replace(Regex("\\s*·\\s*$"), "")
    val text = if (custom != null) "Your area" + (words?.let { " “$it”" } ?: "") else found.describe()
    l.show(toLayer(found.frame), text, custom != null || chosen > 0, custom != null || chosen < candidates.size - 1)
    // The bar has its own way out and its own Comment: the button would only cover them.
    buttonRoot?.visibility = View.INVISIBLE
  }

  /** Ask for the comment on what is picked. */
  private fun compose() {
    val found = picked ?: return
    val a = activity ?: return
    val screen = Inspector.screen(a)
    composing = true
    Env.scope.launch {
      // The picture first. The box is in its own window, never in it.
      val image = Inspector.crop(a, found.frame)
      setPicking(false)
      custom = null
      // The box stays while the comment is written, without taking touches.
      layer?.let { l ->
        l.marking = true
        l.show(toLayer(found.frame), "", false, false)
        layerParams?.let { p ->
          p.flags = p.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
          update(l, p)
        }
      }
      val sheet = ComposeSheet(a, found, screen, image)
      sheet.onSend = { text -> Env.scope.launch { send(Outbox.comment(text, found, screen, image)) } }
      sheet.onMac = onMac@{
        val data = Outbox.comment("", found, screen, image, onMac = true)
        when (val r = Outbox.post(data)) {
          is Outbox.Result.Sent -> {
            Outbox.remember(data, r.id, r.project)
            flash("Opened on your Mac. Write it there.")
            null
          }
          Outbox.Result.Relayed -> {
            Outbox.remember(data, "", null, relayed = true)
            flash("Sent to ${Connection.teamWay}. Write it in the map when you are at your Mac.")
            null
          }
          is Outbox.Result.Rejected -> "grndwrk did not take it (${r.status})."
          Outbox.Result.Unreachable -> "grndwrk is not reachable. Write it here instead, and it goes once it is."
          Outbox.Result.NeedsCode -> "grndwrk needs the pairing code first. Write it here instead, and it goes once paired."
        }
      }
      sheet.onClose = {
        composing = false
        if (!picking) {
          remove(layer)
          layer = null
        }
      }
      sheet.show()
    }
  }

  /** Pick the element at a point in the window and send a comment on it, without asking. For the self test. */
  fun comment(x: Int, y: Int, text: String) {
    val a = activity ?: return
    val found = Inspector.element(a, x, y)
    Env.scope.launch {
      val image = Inspector.crop(a, found.frame)
      send(Outbox.comment(text, found, Inspector.screen(a), image))
    }
  }

  private suspend fun send(data: ByteArray) {
    when (val r = Outbox.post(data)) {
      is Outbox.Result.Sent -> {
        Outbox.remember(data, r.id, r.project)
        flash("Sent to grndwrk")
        Outbox.flush()
      }
      Outbox.Result.Relayed -> {
        Outbox.remember(data, "", null, relayed = true)
        flash("Sent through the relay. It reaches grndwrk when one on your team runs")
        Outbox.flush()
      }
      is Outbox.Result.Rejected -> flash("grndwrk did not take it (${r.status})")
      Outbox.Result.Unreachable -> {
        Outbox.save(data)
        flash("Saved on the phone. It goes to grndwrk once connected (${Outbox.count} waiting)")
      }
      Outbox.Result.NeedsCode -> {
        Outbox.save(data)
        flash("Saved on the phone. It goes once you enter the pairing code (${Outbox.count} waiting)")
      }
    }
    updateBadge()
  }

  // Badge and messages

  /**
   * "grndwrk · 2" while comments wait to be sent, "Offline · 2" while grndwrk
   * cannot be reached, and the dot: green when connected, orange when not.
   */
  fun updateBadge() {
    if (!attached || buttonRoot == null) return
    val a = activity ?: return
    // Offline, the button says so in words, so nobody wonders where comments went.
    // Through the relay it is not offline: comments still go, only another way.
    val relay = Connection.viaRelay || Connection.viaStore
    val offline = Connection.state is Connection.State.Offline && !relay
    val name = if (offline) "Offline" else "grndwrk"
    val count = Outbox.count
    main.text = if (count > 0) "$name · $count" else name
    val icon = Icon(if (offline) Glyph.OFFLINE else if (relay) Glyph.GLOBE else Glyph.BUBBLE, if (picking) 0xFFFFFFFF.toInt() else Colors.light, a.dp(18))
    icon.setBounds(0, 0, a.dp(18), a.dp(18))
    main.setCompoundDrawables(icon, null, null, null)
    main.setTextColor(if (picking) 0xFFFFFFFF.toInt() else Colors.light)
    ((main.parent as? View)?.background as? android.graphics.drawable.GradientDrawable)?.setColor(if (picking) Colors.blue else Colors.dark)
    (dot.background as? android.graphics.drawable.GradientDrawable)?.setColor(
      when (Connection.state) {
        is Connection.State.Connected -> Colors.green
        is Connection.State.NeedsCode -> Colors.yellow
        is Connection.State.Offline -> if (relay) Colors.link else Colors.orange
        Connection.State.Unknown -> Colors.gray
      },
    )
    main.contentDescription = "${main.text}. ${status()}"
    // The test part: how many fixes are ready to test.
    val fixes = Outbox.toTest.size
    testPart.text = "$fixes"
    testPart.contentDescription = if (fixes == 1) "1 fix to test" else "$fixes fixes to test"
    val showTest = fixes > 0 && testing == null && !picking && stashed == null
    testPart.visibility = if (showTest) View.VISIBLE else View.GONE
    divider.visibility = testPart.visibility
  }

  fun flash(text: String) {
    val a = activity ?: return
    if (!attached) return
    remove(toast)
    val t = a.label(text, 13f, Colors.light, bold = true).apply {
      background = rounded(Colors.dark, a.dp(8).toFloat())
      setPadding(a.dp(12), a.dp(6), a.dp(12), a.dp(6))
      maxWidth = size().first - a.dp(32)
      gravity = Gravity.CENTER
    }
    val p = params(a, WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
      floating or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
    p.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
    t.measure(View.MeasureSpec.makeMeasureSpec(size().first - a.dp(32), View.MeasureSpec.AT_MOST), View.MeasureSpec.UNSPECIFIED)
    p.y = toastY(t)
    toast = t
    toastText = text
    add(t, p)
    t.announceForAccessibility(text)
    Env.main.postDelayed({
      if (toastText == text) {
        remove(toast)
        toast = null
        toastText = null
      }
    }, 2800)
  }

  private fun toastY(t: View): Int {
    val a = activity ?: return 0
    val h = if (t.height > 0) t.height else t.measuredHeight
    val (_, wh) = size()
    return keyboardTop?.let { it - h - a.dp(12) } ?: (wh - safe().bottom - h - a.dp(80))
  }

  // Testing a fix

  /** Test one fix: the app goes to the screen when it can, and a card stays on top with what changed, the steps, Approve and Reject. */
  fun startTesting(item: Outbox.Item) {
    testing = item
    stepMarks = mutableMapOf()
    cardOpen = true
    var opened = false
    val open = GrndwrkFeedback.openScreen
    if (item.screen != null && open != null) opened = try { open(item.screen) } catch (_: Exception) { false }
    testOpened = opened
    // Opening a screen may start another activity: the card follows it there.
    Env.main.postDelayed({ testing?.let { if (it === item) buildCard(item, opened) } }, if (opened) 400 else 0)
    updateBadge()
  }

  private fun stopTesting() {
    testing = null
    remove(card)
    card = null
    updateBadge()
  }

  /** What to say when it does not work: the steps marked as not working, to add to. */
  private fun failedSteps(item: Outbox.Item): String = item.steps.mapIndexedNotNull { i, s ->
    if (stepMarks[i] == false) "Step ${i + 1} (${if (s.length > 60) s.take(57) + "..." else s}): " else null
  }.joinToString("\n")

  /** One step: its number (or a tick or a cross), the words, and Works and No. */
  private fun stepRow(a: Activity, i: Int, step: String, item: Outbox.Item, opened: Boolean): View {
    val mark = stepMarks[i]
    val color = when (mark) { true -> Colors.green; false -> Colors.red; null -> Colors.light }
    val badge = a.label(when (mark) { true -> "✓"; false -> "✕"; null -> "${i + 1}" }, 12f, if (mark == null) Colors.alpha(Colors.light, 0.7f) else color, bold = true).apply {
      gravity = Gravity.CENTER
      background = circle(Colors.alpha(color, 0.18f))
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    val words = a.label(step, 14f, if (mark == true) Colors.alpha(Colors.light, 0.55f) else Colors.light)
    fun toggle(title: String, value: Boolean, c: Int): TextView {
      val on = mark == value
      return a.pill(title, null, if (on) c else 0x26FFFFFF, if (on) 0xFFFFFFFF.toInt() else Colors.light, "Step ${i + 1} ${if (value) "works" else "does not work"}", sp = 13f) {
        if (stepMarks[i] == value) stepMarks.remove(i) else stepMarks[i] = value
        buildCard(item, opened)
      }.apply {
        minHeight = a.dp(40)
        setPadding(a.dp(12), a.dp(6), a.dp(12), a.dp(6))
      }
    }
    val row = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP }
    row.addView(badge, LinearLayout.LayoutParams(a.dp(22), a.dp(22)).apply { topMargin = a.dp(2) })
    row.addView(words, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = a.dp(8); marginEnd = a.dp(8) })
    row.addView(horizontal(a, a.dp(4), toggle("Works", true, Colors.green), toggle("No", false, Colors.red)))
    return row
  }

  private fun buildCard(item: Outbox.Item, opened: Boolean) {
    val a = activity ?: return
    if (!attached) return
    val stack = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }
    fun add(v: View, gap: Int = 8) = stack.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (stack.childCount > 0) topMargin = a.dp(gap) })
    fun small(glyph: Glyph, label: String, run: () -> Unit) = a.pill(null, glyph, 0, Colors.light, label, onClick = run)

    val title = a.label("Testing: ${item.text}", 15f, Colors.light, bold = true, lines = 2)
    val fold = small(if (cardOpen) Glyph.UP else Glyph.DOWN, if (cardOpen) "Show less" else "Show the steps") {
      cardOpen = !cardOpen
      buildCard(item, opened)
    }
    val close = small(Glyph.CLOSE, "Stop testing") { stopTesting() }
    // The comment in grndwrk on the Mac, with its whole thread and what changed.
    val mac = small(Glyph.MAC, "Show on my Mac") {
      val node = item.node ?: return@small
      Env.scope.launch {
        val ok = Outbox.showOnMac(node)
        flash(if (ok) "Open on your Mac" else "grndwrk is not reachable. Try again when connected.")
      }
    }
    // Through the store nobody's map is asked to open anything.
    val top = if (Connection.throughStore) horizontal(a, 0, title.fill(), fold, close) else horizontal(a, 0, title.fill(), mac, fold, close)
    add(top)

    if (cardOpen) {
      if (!opened) add(a.label(item.screen?.let { "Go to $it in the app." } ?: "Go to where the comment was made.", 14f, Colors.light, bold = true))
      if (!item.fix.isNullOrEmpty()) {
        add(a.label("What changed", 11f, Colors.alpha(Colors.light, 0.55f), bold = true))
        add(a.label(item.fix, 14f, Colors.light), 4)
      }
      if (item.steps.isEmpty()) {
        add(a.label("To test", 11f, Colors.alpha(Colors.light, 0.55f), bold = true))
        add(a.label(if (!item.test.isNullOrEmpty()) item.test else "Try what the comment was about, and see whether it is right now.", 14f, Colors.light), 4)
      } else {
        val works = item.steps.indices.count { stepMarks[it] == true }
        add(a.label("To test · $works of ${item.steps.size} work", 11f, Colors.alpha(Colors.light, 0.55f), bold = true))
        item.steps.forEachIndexed { i, s -> add(stepRow(a, i, s, item, opened)) }
      }
    }

    val failing = stepMarks.values.contains(false)
    val reject = a.pill(if (failing) "Reject: send back" else "Reject", null, if (failing) Colors.red else Colors.alpha(Colors.red, 0.2f), if (failing) 0xFFFFFFFF.toInt() else Colors.red) { rejectTested(item) }
    val approve = a.pill("Approve: it works", null, if (failing) Colors.alpha(Colors.green, 0.2f) else Colors.green, if (failing) Colors.green else 0xFFFFFFFF.toInt()) { sendTested(item, works = true) }
    add(horizontal(a, a.dp(8), reject, spacer(a), approve), 16)

    val (w, h) = size()
    val scroll = MaxHeightScroll(a, (h * 0.6).toInt() - a.dp(40))
    scroll.addView(stack)
    val frame = card ?: DragFrame(a, vertical = true).also { f ->
      f.background = rounded(Colors.dark, a.dp(20).toFloat())
      f.elevation = a.dp(8).toFloat()
      f.contentDescription = "Testing a fix. Drag to move it up or down"
      f.onDrag = { _, dy ->
        cardOffset += dy.toInt()
        placeCard(clampOnly = true)
      }
    }
    frame.removeAllViews()
    // The grab handle: dragged up or down by the person, so it never sits on what they are testing.
    val grabber = View(a).apply { background = rounded(0x4DFFFFFF, a.dp(2.5f).toFloat()) }
    frame.addView(grabber, FrameLayout.LayoutParams(a.dp(36), a.dp(5), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = a.dp(6) })
    frame.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      setMargins(a.dp(16), a.dp(16), a.dp(10), a.dp(12))
    })
    if (card == null) {
      val p = params(a, WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL, w - 2 * a.dp(12), ViewGroup.LayoutParams.WRAP_CONTENT, floating)
      p.x = a.dp(12)
      if (cardOffset < 0) cardOffset = a.dp(8)
      p.y = safe().top + cardOffset
      card = frame
      cardParams = p
      add(frame, p)
    }
    // Folding or unfolding changes its height: keep it on the screen where it was put.
    frame.post { placeCard() }
  }

  private fun placeCard(clampOnly: Boolean = false) {
    val a = activity ?: return
    val c = card ?: return
    val p = cardParams ?: return
    val room = floorY() - safe().top - c.height - a.dp(8)
    cardOffset = max(a.dp(8), min(cardOffset, room))
    p.y = safe().top + cardOffset
    update(c, p)
    if (clampOnly) return
  }

  private fun rejectTested(item: Outbox.Item) {
    val a = activity ?: return
    alert(
      a, "Reject", "What is still wrong? It goes back to grndwrk with the comment, for the next /feedback.",
      positive = Choice("Reject") { note -> sendTested(item, works = false, note = note) },
      // Rejects it now, and opens it in the map on the Mac to write what is still wrong there. Not through a store.
      neutral = if (Connection.throughStore) null else Choice("Reject and write on the Mac") { note -> sendTested(item, works = false, note = note, onMac = true) },
      field = "Optional" to failedSteps(item),
    )
  }

  private fun sendTested(item: Outbox.Item, works: Boolean, note: String = "", onMac: Boolean = false) {
    val node = item.node ?: return
    Env.scope.launch {
      val ok = Outbox.tested(node, works, note, onMac)
      if (!ok) return@launch flash("grndwrk is not reachable. Try again when connected.")
      stopTesting()
      flash(if (works) "Approved. It is fixed in grndwrk." else if (onMac) "Rejected. Write what is still wrong on your Mac." else "Rejected. It is back in grndwrk with your note.")
    }
  }
}

/**
 * A frame that can be dragged: a move past the touch slop is a drag, which
 * cancels the tap or long press of what is inside. `vertical` drags only up
 * and down.
 */
@SuppressLint("ViewConstructor")
internal class DragFrame(context: Context, private val vertical: Boolean) : FrameLayout(context) {
  var onDrag: (Float, Float) -> Unit = { _, _ -> }
  var onDragEnd: (Float, Float) -> Unit = { _, _ -> }
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private var downX = 0f
  private var downY = 0f
  private var lastX = 0f
  private var lastY = 0f
  private var dragging = false
  private var velocity: VelocityTracker? = null

  override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = e.rawX
        downY = e.rawY
        lastX = e.rawX
        lastY = e.rawY
        dragging = false
        velocity?.recycle()
        velocity = VelocityTracker.obtain().also { it.addMovement(e) }
      }
      MotionEvent.ACTION_MOVE -> {
        velocity?.addMovement(e)
        val dx = e.rawX - downX
        val dy = e.rawY - downY
        if (if (vertical) abs(dy) > slop else abs(dx) > slop || abs(dy) > slop) {
          dragging = true
          return true
        }
      }
    }
    return false
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(e: MotionEvent): Boolean {
    velocity?.addMovement(e)
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = e.rawX
        downY = e.rawY
        lastX = e.rawX
        lastY = e.rawY
        dragging = false
        if (velocity == null) velocity = VelocityTracker.obtain().also { it.addMovement(e) }
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (!dragging && (abs(e.rawX - downX) > slop || abs(e.rawY - downY) > slop)) dragging = true
        if (dragging) {
          onDrag(if (vertical) 0f else e.rawX - lastX, e.rawY - lastY)
          lastX = e.rawX
          lastY = e.rawY
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (dragging) {
          velocity?.computeCurrentVelocity(1000)
          onDragEnd(velocity?.xVelocity ?: 0f, velocity?.yVelocity ?: 0f)
        } else if (e.actionMasked == MotionEvent.ACTION_UP && isClickable) {
          performClick()
        }
        dragging = false
        velocity?.recycle()
        velocity = null
      }
    }
    return true
  }

  override fun performClick(): Boolean = super.performClick()
}
