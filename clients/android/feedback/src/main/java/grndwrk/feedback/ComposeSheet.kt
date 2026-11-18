package grndwrk.feedback

import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import kotlinx.coroutines.launch
import java.util.Locale

/** Where the comment is written: typed or spoken here, or on the Mac. */
internal class ComposeSheet(
  private val activity: Activity,
  private val found: Inspector.Found,
  private val screen: Inspector.Screen,
  private val image: ByteArray?,
) {
  /** Send the text. Done with the sheet either way. */
  var onSend: (String) -> Unit = {}
  /** Open it on the Mac instead. Returns a reason when that did not work, and the sheet stays. */
  var onMac: suspend () -> String? = { null }
  var onClose: () -> Unit = {}

  private val palette = Palette(activity)
  private val dialog = Dialog(activity)
  private val field = EditText(activity)
  private lateinit var send: TextView
  private lateinit var mic: TextView
  private lateinit var language: TextView
  private lateinit var mac: TextView
  private val note = activity.label("", 13f, palette.secondary)
  private val dictation = Dictation(activity)
  /** The text before speaking started; what is heard goes after it. */
  private var spokenAfter = ""
  private var closed = false

  fun show() {
    val a = activity
    val pad = a.dp(16)

    // Cancel, the title, Send: as a navigation bar.
    val cancel = a.pill("Cancel", null, Color.TRANSPARENT, Colors.link, sp = 16f) { close() }
    cancel.setTypeface(null, android.graphics.Typeface.NORMAL)
    send = a.pill("Send", null, Color.TRANSPARENT, Colors.link, sp = 16f) { send() }
    val title = a.label("Comment", 17f, palette.text, bold = true).apply { gravity = Gravity.CENTER }
    val bar = horizontal(a, 0, cancel, title.fill(), send)

    // What the comment is about, with the picture of it.
    val thumb = ImageView(a).apply {
      scaleType = ImageView.ScaleType.FIT_CENTER
      background = rounded(palette.field, a.dp(6).toFloat())
      clipToOutline = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      val bitmap = image?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
      if (bitmap != null) setImageBitmap(bitmap) else visibility = View.GONE
    }
    val about = a.label("On ${found.describe()}\nin ${screen.name}", 13f, palette.secondary, lines = 2)
    val context = LinearLayout(a).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      addView(thumb, LinearLayout.LayoutParams(a.dp(64), a.dp(48)).apply { marginEnd = a.dp(10) })
      addView(about, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    field.apply {
      hint = "What should change?"
      textSize = 16f
      setTextColor(palette.text)
      setHintTextColor(palette.secondary)
      background = rounded(palette.field, a.dp(10).toFloat())
      setPadding(a.dp(12), a.dp(10), a.dp(12), a.dp(10))
      minHeight = a.dp(96)
      gravity = Gravity.TOP or Gravity.START
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      contentDescription = "Your comment"
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) { changed() }
      })
    }

    mic = a.pill("Speak", Glyph.MIC, Colors.alpha(Colors.link, 0.15f), Colors.link) { toggleSpeaking() }
    // Which language to listen for, when the person has more than one.
    language = a.pill(short(Dictation.language), null, Color.TRANSPARENT, Colors.link, description = "Listen for ${Dictation.language.getDisplayName(Locale.getDefault())}") { pickLanguage() }
    language.visibility = if (Dictation.languages.size < 2) View.GONE else View.VISIBLE
    mac = a.pill("Write on the Mac", Glyph.MAC, Color.TRANSPARENT, Colors.link) { writeOnMac() }
    mac.maxLines = 1
    val tools = horizontal(a, a.dp(4), mic, language, spacer(a), mac)

    note.visibility = View.GONE

    val stack = vertical(a, a.dp(12), bar, context, field, tools, note)
    stack.setPadding(pad, a.dp(4), pad, pad)
    stack.background = rounded(palette.card, a.dp(20).toFloat())

    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
    dialog.setContentView(stack)
    dialog.window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }
    dialog.keepAboveKeyboard(a, a.dp(8), a.dp(8))
    dialog.setOnCancelListener { finish() }
    Overlay.track(dialog) { finish() }
    changed()
    dialog.show()
    field.requestFocus()
  }

  private fun short(locale: Locale) = locale.language.take(2).uppercase()

  private fun pickLanguage() {
    val menu = PopupMenu(activity, language)
    val list = Dictation.languages
    list.forEachIndexed { i, l -> menu.menu.add(0, i, i, l.getDisplayName(Locale.getDefault())).apply { isCheckable = true; isChecked = l.toLanguageTag() == Dictation.language.toLanguageTag() } }
    menu.setOnMenuItemClickListener { item ->
      val l = list[item.itemId]
      Dictation.language = l
      language.text = short(l)
      language.contentDescription = "Listen for ${l.getDisplayName(Locale.getDefault())}"
      true
    }
    menu.show()
  }

  private fun changed() {
    val empty = field.text.toString().isBlank()
    send.isEnabled = !empty
    send.alpha = if (empty) 0.4f else 1f
    mac.visibility = if (!empty || Connection.project == null) View.GONE else View.VISIBLE
  }

  private fun say(text: String?) {
    note.text = text ?: ""
    note.visibility = if (text == null) View.GONE else View.VISIBLE
  }

  // Speaking

  private fun toggleSpeaking() {
    if (dictation.running) return stopSpeaking()
    if (!Dictation.available(activity)) {
      return say("Speech recognition is not available on this phone. The keyboard's own mic works meanwhile.")
    }
    if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      val asked = Env.prefs.getBoolean("askedMicrophone", false)
      // Asked before and turned down for good: only Settings can change it now.
      if (asked && !activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
        return say("The microphone is off for this app. Turn it on in Settings > Apps > ${Env.appName} > Permissions.")
      }
      Env.prefs.edit().putBoolean("askedMicrophone", true).apply()
      activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 0x6777)
      return say("Allow the microphone, then tap Speak again.")
    }
    val before = field.text.toString().trim()
    spokenAfter = if (before.isEmpty()) "" else "$before "
    setSpeaking(true)
    say("Listening in ${Dictation.language.getDisplayName(Locale.getDefault())}. Tap Stop when done.")
    dictation.start(heard = { text ->
      field.setText(spokenAfter + text)
      field.setSelection(field.text.length)
      changed()
    }, ended = { reason ->
      setSpeaking(false)
      say(reason)
    }, online = {
      say("Listening online in ${Dictation.language.getDisplayName(Locale.getDefault())}: offline speech is not on this phone, so what you say goes to its speech service. Tap Stop when done.")
    })
  }

  private fun stopSpeaking() {
    dictation.stop()
    setSpeaking(false)
    say(null)
  }

  private fun setSpeaking(on: Boolean) {
    mic.text = if (on) "Stop" else "Speak"
    mic.contentDescription = mic.text
    val icon = Icon(if (on) Glyph.STOP else Glyph.MIC, if (on) Colors.red else Colors.link, activity.dp(18)).apply { setBounds(0, 0, activity.dp(18), activity.dp(18)) }
    mic.setCompoundDrawables(icon, null, null, null)
    mic.recolor(Colors.alpha(if (on) Colors.red else Colors.link, 0.15f), if (on) Colors.red else Colors.link)
    if (on) {
      val imm = activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
      imm?.hideSoftInputFromWindow(field.windowToken, 0)
    }
  }

  // Done

  private fun send() {
    stopSpeaking()
    val text = field.text.toString().trim()
    if (text.isEmpty()) return
    dialog.dismiss()
    onSend(text)
    finish()
  }

  private fun writeOnMac() {
    stopSpeaking()
    mac.isEnabled = false
    say("Opening it on the Mac...")
    Env.scope.launch {
      val problem = onMac()
      if (problem != null) {
        mac.isEnabled = true
        say(problem)
        return@launch
      }
      dialog.dismiss()
      finish()
    }
  }

  private fun close() {
    stopSpeaking()
    dialog.dismiss()
    finish()
  }

  private fun finish() {
    if (closed) return
    closed = true
    dictation.stop()
    onClose()
  }
}
