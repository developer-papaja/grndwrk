package grndwrk.feedback

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.text.format.DateFormat
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import kotlinx.coroutines.launch

/**
 * The comments on the phone. First an overview: the connection, and how
 * many fixes wait to be tested, how many comments wait to be sent, and how
 * many were sent. Each opens its own list, and each comment its own page.
 * The refresh button checks again.
 */
internal class CommentsList(private val activity: Activity, private val start: Mode) {
  enum class Mode { OVERVIEW, TO_TEST, WAITING, SENT }

  private sealed class Page {
    data class List(val mode: Mode) : Page()
    data class One(var item: Outbox.Item) : Page()
  }

  private val a = activity
  private val palette = Palette(activity)
  private val dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)
  private val stack = mutableListOf<Page>()
  private val title = a.label("", 17f, palette.text, bold = true).apply { gravity = Gravity.CENTER }
  private val prompt = a.label("", 13f, palette.secondary).apply { gravity = Gravity.CENTER; visibility = View.GONE }
  private val headLeft = FrameLayout(a)
  private val headRight = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END or Gravity.CENTER_VERTICAL }
  private val body = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }
  private val scroll = ScrollView(a)
  private var subs = listOf<() -> Unit>()
  private val dates = DateFormat.getDateFormat(a) to DateFormat.getTimeFormat(a)

  fun show() {
    if (a.isFinishing || a.isDestroyed) return
    val head = LinearLayout(a).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(a.dp(4), a.dp(4), a.dp(4), a.dp(4))
      addView(headLeft, LinearLayout.LayoutParams(a.dp(110), ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(headRight, LinearLayout.LayoutParams(a.dp(110), ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    body.setPadding(a.dp(16), a.dp(8), a.dp(16), a.dp(32))
    scroll.addView(body)
    val root = LinearLayout(a).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(palette.background)
      fitsSystemWindows = true
      addView(head)
      addView(prompt, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = a.dp(4) })
      addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
    dialog.setContentView(root)
    dialog.window?.apply {
      setBackgroundDrawable(ColorDrawable(palette.background))
      setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }
    dialog.setOnKeyListener { _, code, e ->
      if (code == android.view.KeyEvent.KEYCODE_BACK && e.action == android.view.KeyEvent.ACTION_UP && stack.size > 1) {
        pop()
        true
      } else false
    }
    stack += Page.List(Mode.OVERVIEW)
    if (start != Mode.OVERVIEW) stack += Page.List(start)
    subs = listOf(Bus.CONNECTION, Bus.OUTBOX, Bus.RELAY, Bus.STORE).map { name -> Bus.on(name) { if (stack.lastOrNull() is Page.List) build() } }
    Overlay.track(dialog) {
      subs.forEach { it() }
      subs = emptyList()
    }
    build()
    dialog.show()
    if (start == Mode.OVERVIEW) refresh()
  }

  private fun close() = dialog.dismiss()

  private fun push(page: Page) {
    stack += page
    build()
    scroll.scrollTo(0, 0)
  }

  private fun pop() {
    if (stack.size > 1) stack.removeAt(stack.size - 1)
    build()
  }

  /** Check the connection, send what waits, and ask what became of the sent ones. */
  private fun refresh() {
    Env.scope.launch {
      Connection.check()
      Outbox.flush()
      Outbox.sync()
      build()
    }
  }

  /** A short message above the list. The grndwrk button's messages would sit behind this sheet. */
  fun say(text: String) {
    prompt.text = text
    prompt.visibility = View.VISIBLE
    prompt.announceForAccessibility(text)
    Env.main.postDelayed({ if (prompt.text == text) prompt.visibility = View.GONE }, 3000)
  }

  private fun build() {
    if (!dialog.isShowing && stack.isEmpty()) return
    val page = stack.lastOrNull() ?: return
    body.removeAllViews()
    headLeft.removeAllViews()
    headRight.removeAllViews()
    // Done on the first page, back on the others.
    val back = if (stack.size == 1) a.pill("Done", null, Color.TRANSPARENT, Colors.link, sp = 16f) { close() }
    else a.pill(if (stack.size == 2) "Comments" else "Back", Glyph.BACK, Color.TRANSPARENT, Colors.link, description = "Back", sp = 16f) { pop() }
    back.setTypeface(null, android.graphics.Typeface.NORMAL)
    headLeft.addView(back, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.START or Gravity.CENTER_VERTICAL))
    when (page) {
      is Page.List -> list(page.mode)
      is Page.One -> one(page)
    }
  }

  // Lists

  private fun list(mode: Mode) {
    title.text = when (mode) {
      Mode.OVERVIEW -> "Comments"
      Mode.TO_TEST -> "Ready to test"
      Mode.WAITING -> "Waiting to be sent"
      Mode.SENT -> "Sent to grndwrk"
    }
    if (mode == Mode.OVERVIEW) headRight.addView(a.pill(null, Glyph.REFRESH, Color.TRANSPARENT, Colors.link, "Check again") { refresh() })
    if (mode != Mode.SENT && mode != Mode.TO_TEST && Outbox.count > 0) {
      lateinit var more: TextView
      more = a.pill(null, Glyph.MORE, Color.TRANSPARENT, Colors.link, "More") {
        val menu = PopupMenu(a, more)
        menu.menu.add(0, 1, 0, "Send now")
        menu.menu.add(0, 2, 1, "Share as a file")
        menu.setOnMenuItemClickListener { m ->
          if (m.itemId == 1) {
            Env.scope.launch {
              Outbox.flush()
              build()
              if (Outbox.count > 0) say("grndwrk is not reachable yet")
            }
          } else {
            Overlay.share(a) { say(it) }
          }
          true
        }
        menu.show()
      }
      headRight.addView(more)
    }
    if (mode == Mode.OVERVIEW) return overview()
    val items = when (mode) {
      Mode.TO_TEST -> Outbox.toTest
      Mode.WAITING -> Outbox.waiting
      Mode.SENT -> Outbox.sent.filter { it.state != "ready" }
      Mode.OVERVIEW -> emptyList()
    }
    if (items.isNotEmpty()) {
      val group = group()
      items.forEach { item -> row(group, item, mode) }
      body.addView(group)
    }
    footer(
      when (mode) {
        Mode.TO_TEST -> if (items.isEmpty()) "Nothing to test right now. A fix shows up here once it is built." else "Test opens the app where it can be tested, with the steps on top. Tap a row to read more first. Hold a row to approve it at once."
        Mode.WAITING -> if (items.isEmpty()) "Nothing waits." else "They go by themselves once grndwrk is reachable. Or share them as a file. Hold a row to delete it."
        Mode.SENT -> if (items.isEmpty()) "Nothing sent yet." else "In grndwrk they are on the Feedback page, in a topic per screen. Deleting one here deletes it there too. Hold a row to delete it."
        Mode.OVERVIEW -> ""
      },
    )
  }

  private fun overview() {
    // The connection.
    val state = Connection.state
    val (color, text) = when (state) {
      is Connection.State.Connected -> Colors.green to "Connected"
      is Connection.State.NeedsCode -> Colors.yellow to "Needs the pairing code"
      is Connection.State.Offline -> if (Connection.viaStore) Colors.link to "To your team's store" else if (Connection.viaRelay) Colors.link to "Through the relay" else Colors.orange to "Not connected"
      Connection.State.Unknown -> Colors.gray to "Looking for grndwrk"
    }
    val secondary = when (state) {
      is Connection.State.Connected -> "${if (state.project.isEmpty()) "grndwrk" else "“${state.project}”"} at ${state.host}"
      is Connection.State.NeedsCode -> "${if (state.project.isEmpty()) "grndwrk" else "“${state.project}”"} at ${state.host}"
      is Connection.State.Offline -> if (Connection.viaStore) Store.host else if (Connection.viaRelay) Relay.joined?.let { try { java.net.URL(it.url).host } catch (_: Exception) { null } } else "Comments wait on the phone"
      Connection.State.Unknown -> null
    }
    val connection = group()
    val dot = View(a).apply { background = circle(color) }
    connection.addView(line(dot, a.dp(12), text, secondary, null, if (state is Connection.State.NeedsCode) ({ Overlay.pair() }) else null))
    body.addView(connection)
    footer(
      when {
        state is Connection.State.NeedsCode -> "Tap to pair: allow this phone in grndwrk on the Mac, or enter the code it shows in the terminal. Comments are kept on the phone until then."
        state is Connection.State.Offline -> when {
          Connection.viaStore -> "${state.why}\n\nComments go straight to your team's store instead, and reach grndwrk when someone on the team runs it. What became of them comes back the same way."
          Store.status != null -> "${state.why}\n\n${Store.status}."
          Connection.viaRelay -> "${state.why}\n\nComments go through your team's relay instead, and reach grndwrk when someone on the team runs it. What became of them comes back the same way."
          Relay.status != null -> "${state.why}\n\n${Relay.status}."
          else -> "${state.why}\n\nComments are kept on the phone until grndwrk answers. Tap the refresh button to check again. Away from this Wi-Fi? Join your team's store with a store link, or its relay with an invite: long press the grndwrk button."
        }
        Store.status != null -> "Also joined: ${Store.status!!.replaceFirstChar { it.lowercase() }}."
        Relay.status != null -> "Also joined: ${Relay.status!!.replaceFirstChar { it.lowercase() }}."
        else -> ""
      },
    )

    // One row per list.
    val lists = listOf(
      Triple(Mode.TO_TEST, "Ready to test", Outbox.toTest.size) to (Glyph.TEST to Colors.link),
      Triple(Mode.WAITING, "Waiting to be sent", Outbox.count) to (Glyph.TRAY to Colors.orange),
      Triple(Mode.SENT, "Sent to grndwrk", Outbox.sent.count { it.state != "ready" }) to (Glyph.SEND to Colors.gray),
    )
    val group = group()
    for ((info, look) in lists) {
      val (mode, name, count) = info
      val icon = View(a).apply { background = Icon(look.first, look.second, a.dp(22)) }
      val strong = mode == Mode.TO_TEST && count > 0
      val r = line(icon, a.dp(22), name, null, "$count", { push(Page.List(mode)) }, bold = strong, valueColor = if (strong) Colors.link else palette.secondary)
      if (group.childCount > 0) group.addView(divider())
      group.addView(r)
    }
    body.addView(group, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = a.dp(20) })
    footer("Ready to test: comments of yours whose fix your agent has built. Tap Test on one: it shows what to do, over the app, with Approve and Reject.")
  }

  private fun group(): LinearLayout = LinearLayout(a).apply {
    orientation = LinearLayout.VERTICAL
    background = rounded(palette.card, a.dp(12).toFloat())
    clipToOutline = true
  }

  private fun divider(): View = View(a).apply {
    setBackgroundColor(palette.line)
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply { marginStart = a.dp(16) }
  }

  private fun footer(text: String) {
    if (text.isEmpty()) return
    body.addView(a.label(text, 13f, palette.secondary).apply { setPadding(a.dp(16), a.dp(6), a.dp(16), 0) })
  }

  /** A row: a small picture or icon, its words, a value or a chevron. */
  private fun line(
    icon: View?,
    iconSize: Int,
    text: String,
    secondary: String?,
    value: String?,
    onTap: (() -> Unit)?,
    bold: Boolean = false,
    valueColor: Int = palette.secondary,
    lines: Int = 2,
    accessory: View? = null,
  ): LinearLayout {
    val row = LinearLayout(a).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = a.dp(52)
      setPadding(a.dp(16), a.dp(10), a.dp(12), a.dp(10))
    }
    if (icon != null) row.addView(icon, LinearLayout.LayoutParams(iconSize, iconSize).apply { marginEnd = a.dp(12) })
    val words = vertical(a, a.dp(2), a.label(text, 16f, palette.text, bold = bold, lines = 3))
    if (!secondary.isNullOrEmpty()) words.addView(a.label(secondary, 13f, palette.secondary, lines = lines))
    row.addView(words, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    if (value != null) row.addView(a.label(value, 16f, valueColor, bold = bold).apply { setPadding(a.dp(8), 0, a.dp(4), 0) })
    if (accessory != null) row.addView(accessory)
    if (onTap != null) {
      if (accessory == null) row.addView(View(a).apply { background = Icon(Glyph.NEXT, palette.secondary, a.dp(16)) }, LinearLayout.LayoutParams(a.dp(16), a.dp(16)))
      row.isClickable = true
      row.isFocusable = true
      row.background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(palette.line), null, ColorDrawable(Color.WHITE))
      row.setOnClickListener { onTap() }
    }
    row.contentDescription = listOfNotNull(text, secondary, value).joinToString(". ")
    return row
  }

  private fun row(group: LinearLayout, item: Outbox.Item, mode: Mode) {
    val picture = item.node?.let { Outbox.picture(it) } ?: item.file?.let { Outbox.picture(it) }
    val thumb = picture?.let { bmp ->
      ImageView(a).apply {
        setImageBitmap(bmp)
        scaleType = ImageView.ScaleType.CENTER_CROP
        background = rounded(palette.field, a.dp(6).toFloat())
        clipToOutline = true
      }
    }
    val secondary = if (mode == Mode.TO_TEST && !item.fix.isNullOrEmpty()) {
      listOfNotNull(item.screen?.let { "On $it" }, item.fix).joinToString("\n")
    } else {
      listOfNotNull(item.detail, item.written?.let { "${dates.first.format(it)} ${dates.second.format(it)}" }).filter { it.isNotEmpty() }.joinToString(" · ")
    }
    val test = if (mode == Mode.TO_TEST) a.pill("Test", null, Colors.link, 0xFFFFFFFF.toInt(), "Test $item.text") {
      close()
      Overlay.startTesting(item)
    } else null
    val r = line(thumb, a.dp(44), item.text, secondary, null, { push(Page.One(item)) }, lines = 3, accessory = test)
    // Hold a row: approve a fix ready to test, or delete a comment, as a swipe does on iOS.
    r.setOnLongClickListener {
      val node = item.node
      if (mode == Mode.TO_TEST && node != null) {
        Choices(a, item.text, "").add("Approve: it works") {
          Env.scope.launch {
            val ok = Outbox.tested(node, works = true)
            say(if (ok) "Approved, fixed in grndwrk" else "grndwrk is not reachable. Try again when connected.")
            build()
          }
        }.show()
      } else if (mode == Mode.WAITING || mode == Mode.SENT) {
        Choices(a, item.text, "").add("Delete", destructive = true) {
          Env.scope.launch {
            delete(item)?.let { say(it) }
            build()
          }
        }.show()
      }
      true
    }
    if (group.childCount > 0) group.addView(divider())
    group.addView(r)
  }

  // One comment: its picture, where it was made, what Claude changed, and what can be done with it here.

  private fun one(page: Page.One) {
    val item = page.item
    title.text = if (item.state == "ready") "Ready to test" else "Comment"
    fun add(v: View, gap: Int = 12) = body.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (body.childCount > 0) topMargin = a.dp(gap) })
    val picture = item.node?.let { Outbox.picture(it) } ?: item.file?.let { Outbox.picture(it) }
    if (picture != null) {
      add(ImageView(a).apply {
        setImageBitmap(picture)
        adjustViewBounds = true
        maxHeight = a.dp(260)
        scaleType = ImageView.ScaleType.FIT_CENTER
        background = rounded(palette.field, a.dp(10).toFloat())
        clipToOutline = true
        contentDescription = "The picture sent with the comment"
      })
    }
    add(a.label(item.text, 20f, palette.text, bold = true))
    // The detail starts with the screen: "Desks · text “Desk 1” · fix proposed · n_1m3f".
    add(a.label(if (item.detail.isEmpty()) "" else "Made on ${item.detail}", 13f, palette.secondary), 4)

    if (!item.fix.isNullOrEmpty() && item.state != "incoming") add(box(if (item.state == "proposed") "Proposed, not built yet" else "What changed", item.fix))
    if (!item.test.isNullOrEmpty() && item.state == "ready") add(box("How to test it", item.test))
    if (item.node != null) {
      if (item.state == "ready") {
        add(button("Test it in the app", Glyph.PLAY, Colors.link, filled = true) {
          close()
          Overlay.startTesting(item)
        })
        add(button("Approve: it works", Glyph.CHECK, Colors.green) { tested(page, works = true) })
        add(button("Reject", Glyph.CLOSE, Colors.red) { reject(page) })
      } else if (item.state == "fixed") {
        add(button("Reopen: it is not fixed", Glyph.BACK, Colors.red) { reject(page) })
      }
      // Through the store nobody's map is asked to open anything.
      if (!Connection.throughStore) {
        add(button("Show on my Mac", Glyph.MAC, Colors.link) {
          val node = item.node
          Env.scope.launch {
            val ok = Outbox.showOnMac(node)
            say(if (ok) "Open on your Mac, with what changed in its thread" else "grndwrk is not reachable. Try again when connected.")
          }
        })
      }
    }
    add(button("Delete", Glyph.TRASH, Colors.red) {
      Env.scope.launch {
        val words = delete(item)
        pop()
        words?.let { say(it) }
      }
    })
  }

  private fun box(title: String, text: String): View = vertical(a, a.dp(4), a.label(title, 12f, palette.secondary), a.label(text, 16f, palette.text)).apply {
    setPadding(a.dp(14), a.dp(12), a.dp(14), a.dp(12))
    background = rounded(palette.card, a.dp(10).toFloat())
  }

  private fun button(title: String, glyph: Glyph, color: Int, filled: Boolean = false, run: () -> Unit): TextView =
    a.pill(title, glyph, if (filled) color else Colors.alpha(color, 0.15f), if (filled) 0xFFFFFFFF.toInt() else color, onClick = run).apply {
      gravity = Gravity.START or Gravity.CENTER_VERTICAL
      background = rounded(if (filled) color else Colors.alpha(color, 0.15f), a.dp(12).toFloat())
      setPadding(a.dp(14), a.dp(12), a.dp(14), a.dp(12))
    }

  private fun reject(page: Page.One) {
    alert(
      a, "Reject", "What is still wrong? It goes back to grndwrk with the comment, for the next /feedback.",
      positive = Choice("Send") { note -> tested(page, works = false, note = note) },
      // Rejects it now, and opens it in the map on the Mac to write what is still wrong there. Not through a store.
      neutral = if (Connection.throughStore) null else Choice("Send and write on the Mac") { note -> tested(page, works = false, note = note, onMac = true) },
      field = "Optional" to "",
    )
  }

  private fun tested(page: Page.One, works: Boolean, note: String = "", onMac: Boolean = false) {
    val node = page.item.node ?: return
    Env.scope.launch {
      val ok = Outbox.tested(node, works, note, onMac)
      if (!ok) return@launch say("grndwrk is not reachable. Try again when connected.")
      Outbox.sent.firstOrNull { it.node == node }?.let { page.item = it }
      say(if (works) "Approved, fixed in grndwrk" else if (onMac) "Rejected. Write what is still wrong on your Mac" else "Rejected, back in grndwrk")
      build()
    }
  }

  /** Delete a waiting or sent comment. Returns what happened, in words, or null. */
  private suspend fun delete(item: Outbox.Item): String? {
    item.file?.let {
      Outbox.remove(listOf(it))
      return null
    }
    val node = item.node?.takeIf { it.isNotEmpty() } ?: return null
    return when (Outbox.deleteSent(node)) {
      Outbox.Deleted.EVERYWHERE -> "Deleted here and in grndwrk"
      Outbox.Deleted.LATER -> "Deleted here. grndwrk deletes it once connected."
      Outbox.Deleted.ONLY_HERE -> "Sent before deleting was possible. Delete $node in grndwrk."
    }
  }
}
