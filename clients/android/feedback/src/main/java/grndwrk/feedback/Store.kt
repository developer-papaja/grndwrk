package grndwrk.feedback

import org.json.JSONObject
import java.util.UUID

/**
 * Sending comments straight to the team's store, away from the Wi-Fi with
 * grndwrk (docs/store-protocol.md, Comments straight to the store). The
 * person joins once with a store link from the team's store (its login, or
 * a link someone sent): `grndwrk:store/<host><path>#<comment token>`. The
 * token may only leave comments in this phone's own inbox folder and read
 * its own status file, never the map. When no grndwrk answers on the Wi-Fi,
 * comments go into the store's inbox, where any teammate's grndwrk files
 * them; test results and deletes go the same way, as envelopes like the
 * relay's, and the status of what was sent comes back from the status file.
 *
 * A phone joined to both a store and a relay uses the store.
 */
internal object Store {
  data class Joined(
    /** The project's address at the store, ending in /. */
    val url: String,
    val token: String,
    /** The id the store gave this phone: its comments go in `inbox/<commenter>/`, its status is `status/<commenter>.json`. */
    val commenter: String,
    /** When the store last refused the token (ms): logged out, or taken back. */
    val refused: Long? = null,
  ) {
    fun toJson(): String = JSONObject().put("url", url).put("token", token).put("commenter", commenter)
      .apply { refused?.let { put("refused", it) } }.toString()

    companion object {
      fun fromJson(s: String): Joined? = try {
        val o = JSONObject(s)
        Joined(o.getString("url"), o.getString("token"), o.getString("commenter"), if (o.has("refused")) o.getLong("refused") else null)
      } catch (_: Exception) {
        null
      }
    }
  }

  sealed class Problem(words: String) : Exception(words) {
    object NotALink : Problem("not a link")
    object Unreachable : Problem("unreachable")
    object Refused : Problem("refused")
    object MayDoMore : Problem("may do more")
    object NoCommenter : Problem("no commenter")
  }

  /** Sealed in Secure, on this device only: never readable from a backup. */
  var joined: Joined?
    get() = Secure.get("store")?.let { Joined.fromJson(it) }
    set(value) {
      Secure.set("store", value?.toJson())
      Bus.post(Bus.STORE)
      // The relay's listeners redraw too: the menu and the list say where comments go.
      Bus.post(Bus.RELAY)
    }

  val host: String get() = joined?.let { try { java.net.URL(it.url).host } catch (_: Exception) { null } } ?: ""

  /** Where comments go when the Wi-Fi has no grndwrk, in words for the list. */
  val status: String?
    get() {
      val j = joined ?: return null
      return if (j.refused == null) "Straight to your team's store at $host when no grndwrk is on the Wi-Fi"
      else "Joined your team's store at $host, but it no longer takes this phone's link. Join again with a new store link"
    }

  // Joining

  fun isCommenter(s: String) = s.length in 8..64 && s.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '_' || it == '-' }

  private const val TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-"

  /**
   * `grndwrk:store/<host><path>#<token>`. Not a web address, so a browser never takes the token anywhere.
   * The store is reached over https; http only for localhost, to try it out. Returns (url, token).
   */
  fun parse(link: String): Pair<String, String>? {
    val text = link.trim()
    if (!text.startsWith("grndwrk:store/")) return null
    val hash = text.indexOf('#')
    if (hash < 0) return null
    val place = text.substring("grndwrk:store/".length, hash)
    val token = text.substring(hash + 1)
    if (token.length !in 8..4096 || !token.all { it in TOKEN_CHARS }) return null
    val slash = place.indexOf('/').let { if (it < 0) place.length else it }
    val host = place.substring(0, slash)
    var path = place.substring(slash)
    val hostPart = host.split(":", limit = 2)
    val name = hostPart[0]
    if (name.isEmpty() || !name.all { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '-' }) return null
    if (hostPart.size == 2 && (hostPart[1].length > 5 || !hostPart[1].all { it in '0'..'9' })) return null
    if (!path.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it in "._~%/-" } || path.contains("..")) return null
    if (!path.endsWith("/")) path += "/"
    val local = name == "localhost" || name == "127.0.0.1"
    return "${if (local) "http" else "https"}://$host$path" to token
  }

  /** Join with a store link: the store says this token may only leave comments, and who this phone is. */
  suspend fun join(link: String) {
    val (url, token) = parse(link) ?: throw Problem.NotALink
    val (status, data) = call(url, token, "GET", "hello")
    if (status == 0) throw Problem.Unreachable
    if (status == 401 || status == 403) throw Problem.Refused
    val hello = (if (status == 200) data?.let { try { JSONObject(String(it)) } catch (_: Exception) { null } } else null)
      ?: throw Problem.Unreachable
    // A token that may read or change the map does not belong on a phone that only comments.
    if (hello.str("role") != "comment") throw Problem.MayDoMore
    val commenter = hello.str("commenter")?.takeIf(::isCommenter) ?: throw Problem.NoCommenter
    joined = Joined(url, token, commenter)
    reachable = true
  }

  fun leave() { joined = null }

  /** Whether the store answered the last time it was asked. */
  var reachable = true
    private set(value) {
      val changed = field != value
      field = value
      if (changed) Bus.post(Bus.STORE)
    }

  /** Joined, the link still taken, and the store answers: comments go there. */
  val usable: Boolean get() = joined.let { it != null && it.refused == null } && reachable

  /** Asks the store whether it still takes this phone's link, so a refused one shows as soon as it is. */
  suspend fun check() {
    val j = joined ?: return
    answer(call(j.url, j.token, "GET", "hello").first, listOf(200))
  }

  // Sending

  /**
   * One request, as it would go to grndwrk on the Wi-Fi: a comment as a file of its own in the inbox,
   * a test result or a delete as an envelope `{ path, body, at }`. Show on my Mac does not go through a store.
   */
  suspend fun send(path: String, body: ByteArray): Relay.Sent {
    val j = joined ?: return Relay.Sent.REFUSED
    val obj = try { JSONObject(String(body)) } catch (_: Exception) { return Relay.Sent.REFUSED }
    val file: String
    val bytes: ByteArray
    when (path) {
      "api/feedback" -> {
        // Written on the Mac is for grndwrk on the Wi-Fi: here nobody's map is asked to open.
        if (obj.has("on_mac")) return Relay.Sent.REFUSED
        // Named after its key, so a try that got no answer and is sent again is the same file.
        val key = obj.str("key") ?: UUID.randomUUID().toString().uppercase()
        obj.put("key", key)
        file = "c_$key"
        bytes = obj.toString().toByteArray()
      }
      "api/feedback/tested", "api/feedback/remove" -> {
        obj.remove("on_mac")
        file = "r_${UUID.randomUUID().toString().uppercase()}"
        bytes = JSONObject().put("path", "/$path").put("body", obj).put("at", System.currentTimeMillis()).toString().toByteArray()
      }
      else -> return Relay.Sent.REFUSED
    }
    if (!isCommenter(file)) return Relay.Sent.REFUSED
    val (status, _) = call(j.url, j.token, "PUT", "files/inbox/${j.commenter}/$file.json", bytes, create = true)
    // 412: there already, from a try that got no answer.
    return answer(status, listOf(200, 201, 412))
  }

  /** What became of the comments sent to the store: grndwrk's status of each, by key. Null when there is no answer. */
  suspend fun statuses(): List<JSONObject>? {
    val j = joined ?: return null
    val (status, data) = call(j.url, j.token, "GET", "files/status/${j.commenter}.json")
    // Nothing filed yet.
    if (status == 404) return emptyList()
    if (answer(status, listOf(200)) != Relay.Sent.LEFT || data == null) return null
    return try { JSONObject(String(data)).optJSONArray("comments")?.objects() } catch (_: Exception) { null }
  }

  /** 401 or 403: the store no longer takes the link. Kept until it does again, or the person joins with a new one. */
  private fun answer(status: Int, ok: List<Int>): Relay.Sent {
    val j = joined ?: return Relay.Sent.REFUSED
    reachable = !(status == 0 || status == 429 || status >= 500)
    if (status in ok) {
      if (j.refused != null) joined = j.copy(refused = null)
      return Relay.Sent.LEFT
    }
    if (status == 401 || status == 403) {
      if (j.refused == null) joined = j.copy(refused = System.currentTimeMillis())
      return Relay.Sent.NOT_LET_IN
    }
    // Refused for good only when the store says what is wrong with it; anything else, it waits on the phone.
    return if (status in listOf(400, 413, 415)) Relay.Sent.REFUSED else Relay.Sent.UNREACHABLE
  }

  /** The token goes only to the store's own address, never after a redirect (Http.call never follows one). */
  private suspend fun call(base: String, token: String, method: String, rest: String, body: ByteArray? = null, create: Boolean = false): Pair<Int, ByteArray?> {
    val headers = mutableMapOf("Authorization" to "Bearer $token")
    if (body != null) headers["Content-Type"] = "application/json"
    if (create) headers["If-None-Match"] = "*"
    return try {
      val a = Http.call("${base}v1/$rest", method, body, headers, 30_000)
      a.status to a.body
    } catch (_: Why) {
      0 to null
    }
  }
}
