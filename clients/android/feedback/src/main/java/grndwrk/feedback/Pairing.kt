package grndwrk.feedback

import kotlinx.coroutines.delay
import org.json.JSONObject
import java.util.UUID

/**
 * Pairing with `grndwrk --lan`: the person allows this phone in the map on
 * the Mac (or types the code the terminal shows, once), and grndwrk gives
 * the phone its own long random key, kept here per project. The key is
 * never sent again: grndwrk proves it holds it, and every request is signed
 * with it, so a recording or a fake grndwrk on the Wi-Fi gets nothing to reuse.
 *
 * The lines and labels are those of src/server/devices.ts and the iOS package.
 */
internal object Pairing {
  /** The key of the grndwrk this phone talks to, which signs every request. */
  var current: String? = null

  private fun name(project: String) = "pair:$project"

  fun key(project: String): String? = Secure.get(name(project))

  fun save(key: String, project: String) {
    if (key.length != 64 || !key.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return
    Secure.set(name(project), key.lowercase())
  }

  fun forget(project: String) = Secure.set(name(project), null)

  /** A one-time word for /api/hello to prove the key with. */
  fun newChallenge(): String = (UUID.randomUUID().toString() + UUID.randomUUID().toString()).replace("-", "").uppercase()

  /** Which key this phone signs with, as grndwrk knows it: a hash, so it tells nobody the key. */
  fun deviceId(key: String): String = Crypto.sha256Hex("grndwrk-device:$key").take(32)

  fun proof(key: String, challenge: String): String = Crypto.hmacHex(key, "grndwrk-hello:$challenge")

  /** The four digits grndwrk shows next to this request in the map, worked out the same way from the secret. */
  fun checkDigits(secret: String): String {
    val n = Crypto.sha256Hex("grndwrk-pair:$secret").take(8).toLong(16)
    return "%04d".format(n % 10000)
  }

  /**
   * The headers that sign a request with the key, the same lines in the same order as
   * src/server/devices.ts: the method, the path, the time, a nonce and a hash of the body.
   */
  fun sign(method: String, url: String, body: ByteArray?): Map<String, String> {
    val key = current ?: return emptyMap()
    val path = java.net.URL(url).path
    val time = System.currentTimeMillis().toString()
    val nonce = UUID.randomUUID().toString().uppercase() + UUID.randomUUID().toString().uppercase().take(8)
    val bodyHash = Crypto.hex(Crypto.sha256(body ?: ByteArray(0)))
    val line = "grndwrk-request\n${method.uppercase()}\n$path\n$time\n$nonce\n$bodyHash"
    return mapOf(
      "X-Grndwrk-Device" to deviceId(key),
      "X-Grndwrk-Time" to time,
      "X-Grndwrk-Nonce" to nonce,
      "X-Grndwrk-Signature" to Crypto.hmacHex(key, line),
    )
  }

  /** A signed POST of JSON to grndwrk. */
  suspend fun post(server: String, path: String, body: ByteArray, timeoutMs: Int = 10_000): Http.Answer {
    // Never to a grndwrk that has not proved it holds this phone's key (Connection.mayPost).
    if (!Connection.mayPost(server)) throw Why("this grndwrk has not proved it is the one this phone paired with")
    val url = join(server, path)
    return Http.call(url, "POST", body, mapOf("Content-Type" to "application/json") + sign("POST", url, body), timeoutMs)
  }

  /** The code typed from the terminal, for a key of this phone's own. Wrong codes lock out for a while. */
  suspend fun pair(code: String): String? {
    val server = Locator.url() ?: return null
    return call(server, "api/pair/code", JSONObject().put("code", code).put("device", Env.deviceName))?.str("key")
  }

  sealed class Asked {
    data class Allowed(val key: String, val digits: String) : Asked()
    object Denied : Asked()
    object NoBrowser : Asked()
    object Unanswered : Asked()
  }

  /**
   * Ask the person at the Mac to allow this phone. grndwrk shows the
   * request in the map with four digits, which `asking` gets too, to show
   * here. Once allowed, this phone's key comes back; it is kept only after the
   * person confirms they allowed it next to those digits. Waits up to three minutes.
   */
  suspend fun ask(asking: (String) -> Unit): Asked {
    val server = Locator.url() ?: return Asked.Unanswered
    // Known only to this phone: grndwrk tells the key to whoever holds it.
    val secret = UUID.randomUUID().toString().uppercase() + "-" + UUID.randomUUID().toString().uppercase().take(8)
    val digits = checkDigits(secret)
    val asked = call(server, "api/pair", JSONObject().put("request", secret).put("device", Env.deviceName).put("app", Env.appName))
      ?: return Asked.Unanswered
    if (asked.has("browser") && !asked.optBoolean("browser", true)) return Asked.NoBrowser
    asking(digits)
    repeat(90) {
      delay(2000)
      val answer = call(server, "api/pair/status", JSONObject().put("request", secret)) ?: return@repeat
      when (answer.str("status")) {
        "allowed" -> return answer.str("key")?.let { Asked.Allowed(it, digits) } ?: Asked.Unanswered
        "denied" -> return Asked.Denied
        "waiting" -> {}
        else -> return Asked.Unanswered
      }
    }
    return Asked.Unanswered
  }

  private suspend fun call(server: String, path: String, body: JSONObject): JSONObject? = try {
    val a = Http.json(join(server, path), "POST", body, timeoutMs = 6000)
    if (a.status == 200 || a.status == 202) a.json else null
  } catch (_: Why) {
    null
  }
}
