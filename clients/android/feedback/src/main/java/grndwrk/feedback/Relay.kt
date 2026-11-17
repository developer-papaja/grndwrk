package grndwrk.feedback

import org.json.JSONObject
import java.util.UUID

/**
 * Sending comments through the team's relay, away from the Wi-Fi with
 * grndwrk. The person joins once with an invite (a link, or its QR code);
 * the phone makes a key of its own and leaves it at the relay sealed with
 * the invite's secret, for the team's grndwrk to let it in. From then on,
 * when no grndwrk answers on the Wi-Fi, comments go to the relay sealed and
 * signed, and the status of the sent ones comes back the same way.
 *
 * The same keys, labels and lines as relay/src/crypto.ts and
 * src/relay/keys.ts: HMACs keyed by a key's hex text, AES-256-GCM with the
 * place bound in (`inbox:<device>`), nonce, ciphertext and tag in a row.
 */
internal object Relay {
  data class Joined(
    val url: String,
    val mailbox: String,
    val key: String,
    /** When the relay last refused this phone (ms): not let in yet, or taken out. */
    val refused: Long? = null,
    /** When grndwrk made the last status read: an older one handed over again is ignored. */
    val statusAt: Double? = null,
  ) {
    /** The four digits to tell whoever invited you; they allow this phone when the map shows the same. */
    val digits: String get() = Relay.digits(key)

    fun toJson(): String = JSONObject().put("url", url).put("mailbox", mailbox).put("key", key)
      .apply { refused?.let { put("refused", it) }; statusAt?.let { put("statusAt", it) } }.toString()

    companion object {
      fun fromJson(s: String): Joined? = try {
        val o = JSONObject(s)
        Joined(
          o.getString("url"), o.getString("mailbox"), o.getString("key"),
          if (o.has("refused")) o.getLong("refused") else null,
          if (o.has("statusAt")) o.getDouble("statusAt") else null,
        )
      } catch (_: Exception) {
        null
      }
    }
  }

  sealed class Problem(words: String) : Exception(words) {
    object NotALink : Problem("not a link")
    object Unreachable : Problem("unreachable")
    object Expired : Problem("expired")
    object Used : Problem("used")
    class Refused(val status: Int) : Problem("refused $status")
  }

  /** Sealed in Secure, on this device only: never readable from a backup. */
  var joined: Joined?
    get() = Secure.get("relay")?.let { Joined.fromJson(it) }
    set(value) {
      Secure.set("relay", value?.toJson())
      Bus.post(Bus.RELAY)
    }

  /** The same four digits grndwrk shows next to this phone in the map (`joinDigits` in src/relay/sync.ts). */
  fun digits(key: String): String {
    val n = Crypto.sha256Hex("grndwrk-join:$key").take(8).toLong(16)
    return "%04d".format(n % 10000)
  }

  /** Where comments go when the Wi-Fi has no grndwrk, in words for the list. */
  val status: String?
    get() {
      val j = joined ?: return null
      val host = try { java.net.URL(j.url).host } catch (_: Exception) { j.url }
      return if (j.refused == null) "Through the relay at $host when no grndwrk is on the Wi-Fi"
      else "Joined the relay at $host. Waiting to be allowed: tell whoever invited you the digits ${j.digits}"
    }

  // Joining

  private fun isLowerHex(c: Char) = c in '0'..'9' || c in 'a'..'f'
  private fun isKey(s: String) = s.length == 64 && s.all(::isLowerHex)

  /**
   * `grndwrk:invite/<relay host>/<mailbox>/<secret>`, as the map shows it. Not a web address, so a browser never takes it to the relay.
   * The relay is reached over https; http only for localhost, to try it out. Returns (url, mailbox, secret).
   */
  fun parse(link: String): Triple<String, String, String>? {
    val text = link.trim()
    if (!text.startsWith("grndwrk:invite/")) return null
    val parts = text.removePrefix("grndwrk:invite/").split("/")
    if (parts.size != 3 || parts[1].length != 32 || !parts[1].all(::isLowerHex) || !isKey(parts[2])) return null
    val host = parts[0]
    val hostPart = host.split(":", limit = 2)
    val name = hostPart[0]
    if (name.isEmpty() || !name.all { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '-' }) return null
    if (hostPart.size == 2 && (hostPart[1].length > 5 || hostPart[1].isEmpty() || !hostPart[1].all { it in '0'..'9' })) return null
    val local = name == "localhost" || name == "127.0.0.1"
    return Triple("${if (local) "http" else "https"}://$host", parts[1], parts[2])
  }

  /** Join with an invite: leave a new key, sealed with the invite's secret. The invite works once. */
  suspend fun join(link: String) {
    val (url, mailbox, secret) = parse(link) ?: throw Problem.NotALink
    val key = Crypto.randomHex(32)
    val invite = Crypto.sha256Hex("grndwrk-invite:$secret").take(32)
    val plain = JSONObject().put("key", key).toString().toByteArray()
    val sealed = seal(plain, secret, "join:$invite") ?: throw Problem.NotALink
    val status = try {
      Http.call("$url/v1/$mailbox/join/$invite", "POST", sealed, timeoutMs = 15_000).status
    } catch (_: Why) {
      throw Problem.Unreachable
    }
    when (status) {
      202 -> joined = Joined(url, mailbox, key, refused = System.currentTimeMillis())
      404 -> throw Problem.Expired
      409 -> throw Problem.Used
      else -> throw Problem.Refused(status)
    }
  }

  fun leave() { joined = null }

  /** Whether the relay answered the last time it was asked. Comments go there only then; otherwise they wait on the phone. */
  var reachable = true
    private set(value) {
      val changed = field != value
      field = value
      if (changed) Bus.post(Bus.RELAY)
    }

  /** Joined, allowed in, and the relay answers: comments go through it. */
  val usable: Boolean get() = joined.let { it != null && it.refused == null } && reachable

  /**
   * The person chose to keep using the relay when grndwrk turned up on the Wi-Fi unpaired: not asked to pair again.
   * Kept per project; Pair with the Mac in the long-press menu still pairs.
   */
  fun keepsRelay(project: String): Boolean = Env.prefs.getBoolean("keepRelay.$project", false)
  fun setKeepsRelay(project: String, keep: Boolean) = Env.prefs.edit().putBoolean("keepRelay.$project", keep).apply()

  /**
   * Asks the relay whether it lets this phone in, without taking anything: so "waiting to be allowed"
   * ends as soon as someone allows it in the map, not only at the next comment.
   */
  suspend fun check() {
    val j = joined ?: return
    answer(call(j, "GET", "/outbox").first, 200)
  }

  // Sending

  enum class Sent { LEFT, NOT_LET_IN, UNREACHABLE, REFUSED }

  /** One request, as it would go to grndwrk on the Wi-Fi (`api/feedback`, `api/feedback/tested` ...), sealed and left at the relay. */
  suspend fun send(path: String, body: ByteArray): Sent {
    val j = joined ?: return Sent.REFUSED
    val obj = try { JSONObject(String(body)) } catch (_: Exception) { return Sent.REFUSED }
    // An id and the time, sealed with it: grndwrk refuses one the relay hands over again.
    val plain = JSONObject().put("path", "/$path").put("body", obj).put("id", UUID.randomUUID().toString().uppercase())
      .put("at", System.currentTimeMillis()).toString().toByteArray()
    val sealed = seal(plain, sealKey(j.key), "inbox:${deviceId(j.key)}") ?: return Sent.REFUSED
    return answer(call(j, "POST", "/inbox", sealed).first, 202)
  }

  /** What became of the comments sent through the relay: grndwrk's status of each, by key. Null when there is nothing new or no answer. */
  suspend fun statuses(): List<JSONObject>? {
    val j = joined ?: return null
    val (status, data) = call(j, "GET", "/outbox")
    if (answer(status, 200) != Sent.LEFT || data == null) return null
    val plain = open(data, sealKey(j.key), "outbox:${deviceId(j.key)}") ?: return null
    val answer = try { JSONObject(String(plain)) } catch (_: Exception) { return null }
    val list = answer.optJSONArray("comments")?.objects() ?: return null
    // An older status than the last one read, handed over again by the relay: ignored.
    val at = answer.optDouble("at", 0.0).let { if (it.isNaN()) 0.0 else it }
    joined?.let { now ->
      if (now.statusAt != null && at <= now.statusAt) return null
      joined = now.copy(statusAt = at)
    }
    return list
  }

  /** 401: the team's grndwrk has not let this phone in yet, or took it out. Kept until it answers again. */
  private fun answer(status: Int, ok: Int): Sent {
    val j = joined ?: return Sent.REFUSED
    reachable = !(status == 0 || status == 429 || status >= 500)
    if (status == ok || (ok == 200 && status == 204)) {
      if (j.refused != null) joined = j.copy(refused = null)
      return if (status == 204) Sent.UNREACHABLE else Sent.LEFT
    }
    if (status == 401) {
      if (j.refused == null) joined = j.copy(refused = System.currentTimeMillis())
      return Sent.NOT_LET_IN
    }
    return if (status == 0 || status == 429 || status >= 500) Sent.UNREACHABLE else Sent.REFUSED
  }

  private suspend fun call(j: Joined, method: String, rest: String, body: ByteArray? = null): Pair<Int, ByteArray?> {
    val url = "${j.url}/v1/${j.mailbox}$rest"
    val path = try { java.net.URL(url).path } catch (_: Exception) { return 0 to null }
    val time = System.currentTimeMillis().toString()
    val nonce = UUID.randomUUID().toString().uppercase() + UUID.randomUUID().toString().uppercase().take(8)
    val headers = mapOf(
      "X-Grndwrk-Device" to deviceId(j.key),
      "X-Grndwrk-Time" to time,
      "X-Grndwrk-Nonce" to nonce,
      "X-Grndwrk-Signature" to Crypto.hmacHex(signKey(j.key), requestLine(method, path, time, nonce, body)),
    )
    return try {
      val a = Http.call(url, method, body, headers, 30_000)
      a.status to a.body
    } catch (_: Why) {
      0 to null
    }
  }

  // Keys and sealing

  /** The line a request's signature covers, as `requestSignature` in src/server/devices.ts. */
  fun requestLine(method: String, path: String, time: String, nonce: String, body: ByteArray?): String =
    "grndwrk-request\n${method.uppercase()}\n$path\n$time\n$nonce\n${Crypto.hex(Crypto.sha256(body ?: ByteArray(0)))}"

  fun signKey(key: String): String = Crypto.hmacHex(key, "grndwrk-relay:sign")
  fun sealKey(key: String): String = Crypto.hmacHex(key, "grndwrk-relay:seal")

  /** The phone's id at the relay, from its signing key. */
  fun deviceId(key: String): String = Crypto.sha256Hex("grndwrk-device:${signKey(key)}").take(32)

  /** Sealed with the key's bytes (its hex read as 32 bytes), as CryptoKit's AES.GCM.seal(...).combined. */
  fun seal(plain: ByteArray, key: String, context: String): ByteArray? {
    val raw = Crypto.bytes(key)?.takeIf { it.size == 32 } ?: return null
    return Crypto.seal(plain, raw, context)
  }

  fun open(sealed: ByteArray, key: String, context: String): ByteArray? {
    val raw = Crypto.bytes(key)?.takeIf { it.size == 32 } ?: return null
    return Crypto.open(sealed, raw, context)
  }
}
