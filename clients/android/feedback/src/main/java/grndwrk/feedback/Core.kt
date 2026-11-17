package grndwrk.feedback

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException

/**
 * Every step of finding and reaching grndwrk, for Logcat: filter on the tag
 * `GrndwrkFeedback`.
 */
internal object gwLog {
  private const val TAG = "GrndwrkFeedback"
  fun info(s: String) { Log.i(TAG, s) }
  fun error(s: String) { Log.e(TAG, s) }
  fun fault(s: String) { Log.wtf(TAG, s) }
}

/** The app, once started. Everything in the package runs on the main thread, as @MainActor does on iOS; network calls switch to IO. */
@SuppressLint("StaticFieldLeak")
internal object Env {
  lateinit var app: Context
  val main = Handler(Looper.getMainLooper())
  /** Main-thread work, like `Task { @MainActor in }`. */
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  val prefs: SharedPreferences by lazy { app.getSharedPreferences("grndwrk.feedback", Context.MODE_PRIVATE) }

  /** The Android emulator, which reaches the Mac as 10.0.2.2. */
  val isEmulator: Boolean by lazy {
    Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator") || Build.HARDWARE == "ranchu" ||
      Build.HARDWARE == "goldfish" || Build.PRODUCT.contains("sdk") || Build.MODEL.contains("Emulator")
  }

  /** The device's name, as the map shows it in "wants to send comments". */
  val deviceName: String
    get() = android.provider.Settings.Global.getString(app.contentResolver, "device_name") ?: "${Build.MANUFACTURER} ${Build.MODEL}"

  /** The app's name, as the person knows it. */
  val appName: String
    get() = app.applicationInfo.loadLabel(app.packageManager).toString()
}

/** Things that changed, for whoever shows them: NotificationCenter in the iOS package. Always on the main thread. */
internal object Bus {
  const val CONNECTION = "connection"
  const val OUTBOX = "outbox"
  const val NEW_FIXES = "newFixes"
  const val RELAY = "relay"
  const val STORE = "store"
  const val TOOK_PICTURE = "tookPicture"

  private val listeners = mutableMapOf<String, MutableList<(Map<String, Any?>) -> Unit>>()

  fun on(name: String, fn: (Map<String, Any?>) -> Unit): () -> Unit {
    listeners.getOrPut(name) { mutableListOf() }.add(fn)
    return { listeners[name]?.remove(fn) }
  }

  fun post(name: String, info: Map<String, Any?> = emptyMap()) {
    val run = Runnable { listeners[name]?.toList()?.forEach { it(info) } }
    if (Looper.myLooper() == Looper.getMainLooper()) run.run() else Env.main.post(run)
  }
}

/** An error in words, for the phone and the log. */
internal class Why(val words: String) : Exception(words)

/** One HTTP request. Never follows a redirect, so nothing sent ever goes to an address other than the one asked. */
internal object Http {
  class Answer(val status: Int, val body: ByteArray) {
    val json: JSONObject? get() = try { JSONObject(String(body)) } catch (_: Exception) { null }
  }

  suspend fun call(
    url: String,
    method: String = "GET",
    body: ByteArray? = null,
    headers: Map<String, String> = emptyMap(),
    timeoutMs: Int = 10_000,
  ): Answer = withContext(Dispatchers.IO) {
    val c = URL(url).openConnection() as HttpURLConnection
    try {
      c.instanceFollowRedirects = false
      c.requestMethod = method
      c.connectTimeout = timeoutMs
      c.readTimeout = timeoutMs
      c.useCaches = false
      for ((k, v) in headers) c.setRequestProperty(k, v)
      if (body != null) {
        c.doOutput = true
        c.setFixedLengthStreamingMode(body.size)
        c.outputStream.use { it.write(body) }
      }
      val status = c.responseCode
      val stream = if (status >= 400) c.errorStream else c.inputStream
      // An answer is small: a status, an id. Never read more than a few megabytes.
      val bytes = stream?.use { readCapped(it, 8 shl 20) } ?: ByteArray(0)
      Answer(status, bytes)
    } catch (e: IOException) {
      throw Why(words(e))
    } finally {
      c.disconnect()
    }
  }

  private fun readCapped(input: java.io.InputStream, cap: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(16 * 1024)
    while (true) {
      val n = input.read(buf)
      if (n < 0) break
      out.write(buf, 0, n)
      if (out.size() > cap) throw IOException("the answer was too large")
    }
    return out.toByteArray()
  }

  suspend fun json(url: String, method: String, body: JSONObject, headers: Map<String, String> = emptyMap(), timeoutMs: Int = 10_000) =
    call(url, method, body.toString().toByteArray(), headers + ("Content-Type" to "application/json"), timeoutMs)

  /** A failed request in plain words. */
  fun words(e: Exception): String = when (e) {
    is SocketTimeoutException -> "no answer in time"
    is ConnectException -> "nothing is listening there (a grndwrk that has stopped?)"
    is UnknownHostException -> "its address could not be found"
    is java.net.NoRouteToHostException -> "it cannot be reached from this network"
    else -> {
      val m = e.message ?: e.javaClass.simpleName
      if (m.contains("CLEARTEXT", ignoreCase = true)) "blocked by Android: plain http is not allowed in this app (see GrndwrkFeedback's README, Network)" else m
    }
  }
}

/** The address of a path under a base URL, as URL.appendingPathComponent does. */
internal fun join(base: String, path: String): String = base.trimEnd('/') + "/" + path.trimStart('/')

internal fun JSONObject.str(key: String): String? = if (has(key) && !isNull(key)) optString(key) else null

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

internal fun JSONArray.strings(): List<String> = (0 until length()).mapNotNull { if (isNull(it)) null else optString(it) }

internal fun jsonList(list: List<JSONObject>): JSONArray = JSONArray().also { a -> list.forEach { a.put(it) } }
