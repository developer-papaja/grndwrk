package grndwrk.feedback

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.launch

/**
 * Joining the team's relay with an invite from the map, or the team's store
 * with a store link from the store: the link pasted, or its QR code scanned.
 * Scanning uses Google's code scanner, which reads the code in a screen of
 * its own and hands back only the text: the app needs no camera permission.
 * Where Google Play services are missing, only pasting works.
 */
internal object Join {
  /** A store link or a relay invite: the only codes and texts joining takes. */
  fun isTeamLink(text: String): Boolean = Store.parse(text) != null || Relay.parse(text) != null

  /** Ask for the link, join with it, and say how it went. `done` runs once it is over, joined or not. */
  fun present(activity: Activity, done: () -> Unit) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val copied = try { clipboard?.primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString() ?: "" } catch (_: Exception) { "" }
    val field = EditText(activity).apply {
      hint = "grndwrk:store/... or grndwrk:invite/..."
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      isSingleLine = true
      setText(if (isTeamLink(copied)) copied.trim() else "")
    }
    val pad = (20 * activity.resources.displayMetrics.density).toInt()
    val box = FrameLayout(activity).apply { setPadding(pad, 0, pad, 0); addView(field) }
    var handedOn = false
    AlertDialog.Builder(activity)
      .setTitle("Join your team")
      .setMessage("Paste the store link from your team's store, or the invite link from grndwrk, or scan its QR code. Comments then go to your team when grndwrk is not on this Wi-Fi.")
      .setView(box)
      .setPositiveButton("Join") { _, _ ->
        handedOn = true
        join(activity, field.text.toString(), done)
      }
      .setNeutralButton("Scan the QR code") { _, _ ->
        handedOn = true
        scan(activity, done)
      }
      .setNegativeButton("Cancel", null)
      .create()
      // grndwrk's own dialog: never taken for one of the app's (Windows.kt), and no picture of the screen while it is up.
      .also { Overlay.track(it) { if (!handedOn) done() } }
      .show()
  }

  /** Google's code scanner: only an invite or a store link is taken, any other code says so. */
  private fun scan(activity: Activity, done: () -> Unit) {
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    try {
      GmsBarcodeScanning.getClient(activity, options).startScan()
        .addOnSuccessListener { code ->
          val text = code.rawValue ?: ""
          if (isTeamLink(text)) join(activity, text, done)
          else {
            flash(activity, "That code is not a store link or an invite from grndwrk")
            done()
          }
        }
        .addOnCanceledListener { done() }
        .addOnFailureListener {
          gwLog.error("The code scanner failed: ${it.message}")
          flash(activity, "The code scanner is not available here. Paste the link instead.")
          done()
        }
    } catch (e: Exception) {
      gwLog.error("The code scanner could not start: ${e.message}")
      flash(activity, "The code scanner is not available here. Paste the link instead.")
      done()
    }
  }

  private fun join(activity: Activity, link: String, done: () -> Unit) {
    if (Store.parse(link) != null) return joinStore(activity, link, done)
    Env.scope.launch {
      try {
        Relay.join(link)
        Connection.check()
        showDigits(activity)
      } catch (e: Relay.Problem) {
        flash(activity, when (e) {
          Relay.Problem.NotALink -> "That is not an invite link from grndwrk"
          Relay.Problem.Expired -> "That invite has expired or was withdrawn. Ask for a new one"
          Relay.Problem.Used -> "That invite was used already. Ask for a new one"
          Relay.Problem.Unreachable -> "The relay did not answer. Try again on a network with internet"
          is Relay.Problem.Refused -> "The relay did not take it. Ask for a new invite"
        })
      } finally {
        done()
      }
    }
  }

  private fun joinStore(activity: Activity, link: String, done: () -> Unit) {
    Env.scope.launch {
      try {
        Store.join(link)
        Connection.check()
        flash(activity, "Joined your team's store. Comments go there when grndwrk is not on this Wi-Fi")
      } catch (e: Store.Problem) {
        flash(activity, when (e) {
          Store.Problem.Refused -> "The store did not take that link. Log in to the store again for a new one"
          Store.Problem.MayDoMore -> "That link may do more than leave comments. Ask your store for a comment link"
          Store.Problem.NoCommenter -> "That store does not say who you are. Ask whoever runs it to update it"
          else -> "The store did not answer. Try again on a network with internet"
        })
      } finally {
        done()
      }
    }
  }

  /** Whoever invited you allows this phone in their map, when it shows the same four digits. */
  fun showDigits(activity: Activity) {
    val digits = Relay.joined?.digits ?: return
    if (activity.isFinishing) return
    AlertDialog.Builder(activity)
      .setTitle(digits)
      .setMessage("Tell whoever invited you these four digits. They allow this phone in grndwrk when their map shows the same. Until then, comments wait on the phone.")
      .setPositiveButton("OK", null)
      .create().also { Overlay.track(it) }
      .show()
  }

  fun leaveStore(activity: Activity) {
    AlertDialog.Builder(activity)
      .setTitle("Leave your team's store?")
      .setMessage("Comments then go only to grndwrk on this Wi-Fi${if (Relay.joined != null) " or through the relay" else ""}. Joining again needs a store link.")
      .setNegativeButton("Cancel", null)
      .setPositiveButton("Leave") { _, _ ->
        Store.leave()
        flash(activity, "Left your team's store")
      }
      .create().also { Overlay.track(it) }
      .show()
  }

  fun leaveRelay(activity: Activity) {
    AlertDialog.Builder(activity)
      .setTitle("Leave the relay?")
      .setMessage("Comments then go only to grndwrk on this Wi-Fi. Joining again needs a new invite.")
      .setNegativeButton("Cancel", null)
      .setPositiveButton("Leave") { _, _ ->
        Relay.leave()
        flash(activity, "Left the relay")
      }
      .create().also { Overlay.track(it) }
      .show()
  }

  private fun flash(activity: Activity, text: String) {
    Toast.makeText(activity.applicationContext, text, Toast.LENGTH_LONG).show()
  }
}
