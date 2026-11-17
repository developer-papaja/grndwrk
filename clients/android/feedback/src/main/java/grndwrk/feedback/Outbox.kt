package grndwrk.feedback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Comments on the device: the ones waiting to be sent, one JSON file each in
 * the app's files, sent in the order they were written once grndwrk
 * answers; and the ones sent, kept in sent.json so the person can look back,
 * delete them, and see what became of them in grndwrk.
 *
 * Every comment carries a random key. grndwrk keeps it, and only a device
 * that holds the key can ask about the comment or delete it.
 */
internal object Outbox {
  /** Relayed: left at the team's store or relay, for a grndwrk on the team to fetch; its id in grndwrk comes later, with its status. */
  sealed class Result {
    data class Sent(val id: String, val project: String?) : Result()
    object Relayed : Result()
    data class Rejected(val status: Int) : Result()
    object Unreachable : Result()
    object NeedsCode : Result()
  }

  /** Taken: by grndwrk, or by the relay for it. */
  fun taken(r: Result) = r is Result.Sent || r is Result.Relayed

  /** A comment as the list shows it. */
  data class Item(
    val file: File?,
    /** The node id in grndwrk, for sent comments. */
    val node: String?,
    val text: String,
    val detail: String,
    val written: Date?,
    /** incoming, proposed, ready or fixed, as grndwrk last said. */
    val state: String?,
    /** What Claude wrote about the fix it proposed or made. */
    val fix: String?,
    /** The screen it was made on, as the app named it. */
    val screen: String?,
    /** How to test the fix, as Claude wrote it after "To test:". */
    val test: String?,
    /** The same, one step each. */
    val steps: List<String>,
    /** How far the agent checked each step itself, in step order: null where it did not. */
    val checks: List<Check?> = emptyList(),
    /** One line on it from grndwrk: "1 tested automatically, 1 left for you." */
    val checkSummary: String? = null,
  )

  /** A check the agent made: `automated` (a test ran and passed), `agent` (it tried it) or `outdated` (the step no longer fits). */
  data class Check(val kind: String, val note: String) {
    val glyph: Glyph get() = when (kind) { "automated" -> Glyph.BEAKER; "agent" -> Glyph.SPARKLE; else -> Glyph.CLOCK }
    val color: Int get() = when (kind) { "automated" -> 0xFF34D399.toInt(); "agent" -> 0xFF38BDF8.toInt(); else -> 0xFFFBBF24.toInt() }
    val words: String
      get() {
        val what = when (kind) { "automated" -> "Tested automatically"; "agent" -> "Checked by your agent"; else -> "Looks out of date" }
        return if (note.isEmpty()) what else "$what: $note"
      }
  }

  private var flushing = false
  private val base: File get() = File(Env.app.filesDir, "GrndwrkFeedback").also { it.mkdirs() }
  private val dir: File get() = File(base, "outbox")
  private val files: List<File> get() = (dir.listFiles() ?: emptyArray()).filter { it.name.endsWith(".json") }.sortedBy { it.name }
  val count: Int get() = files.size

  fun iso(date: Date = Date()): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(date)

  private fun parseIso(s: String?): Date? = try {
    s?.let { SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(it) }
  } catch (_: Exception) {
    null
  }

  /** A new comment, ready to send. */
  fun comment(text: String, found: Inspector.Found, screen: Inspector.Screen, image: ByteArray?, onMac: Boolean = false): ByteArray {
    val element = JSONObject().put("role", found.role)
    found.label?.let { element.put("label", it) }
    found.identifier?.let { element.put("id", it) }
    screen.component?.let { element.put("component", it) }
    val body = JSONObject()
      .put("text", text).put("platform", "Android").put("screen", screen.name).put("element", element)
      .put("written", iso()).put("key", UUID.randomUUID().toString().uppercase())
    if (onMac) body.put("on_mac", true)
    if (image != null) body.put("image", "data:image/png;base64," + Base64.encodeToString(image, Base64.NO_WRAP))
    return body.toString().toByteArray()
  }

  fun save(data: ByteArray) {
    dir.mkdirs()
    File(dir, "${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(6)}.json").writeBytes(data)
    Bus.post(Bus.OUTBOX)
  }

  suspend fun post(data: ByteArray, path: String = "api/feedback"): Result {
    // No grndwrk on this Wi-Fi, and the phone joined the team's relay: it goes there.
    // Or grndwrk is here but this phone is not paired with it: never held back for that.
    if (Connection.sendsToTeam) return viaTeam(data, path)
    val server = Locator.url()
    if (server == null) {
      Connection.reached(false, why = Locator.problem)
      return if (Relay.joined != null || Store.joined != null) viaTeam(data, path) else Result.Unreachable
    }
    val host = java.net.URL(server).host
    // Only to the grndwrk that proved it holds this phone's key: anything on the Wi-Fi can answer
    // as grndwrk. Not paired yet: through the team when this phone joined it, else it waits.
    if (!Connection.mayPost(server)) {
      return if (Relay.joined != null || Store.joined != null) viaTeam(data, path) else Result.NeedsCode
    }
    return try {
      val a = Pairing.post(server, path, data)
      val answer = a.json
      when {
        // Not paired: nothing is lost, it waits until it is.
        a.status == 401 -> {
          Connection.codeRefused()
          Result.NeedsCode
        }
        // Too many at once: keep it and try again later.
        a.status == 429 -> Result.Unreachable
        a.status == 200 || a.status == 201 -> {
          Connection.reached(true, answer?.str("project"))
          Result.Sent(answer?.str("id") ?: "", answer?.str("project"))
        }
        // An old grndwrk without comments, or a server error: keep it for later.
        a.status == 404 || a.status >= 500 -> {
          gwLog.error("Sending to $server got ${a.status}")
          Locator.forget()
          Connection.reached(false, why = "grndwrk at $host answered ${a.status} to a comment.")
          Result.Unreachable
        }
        else -> Result.Rejected(a.status)
      }
    } catch (e: Why) {
      // grndwrk may have moved, or stopped: look for it again next time.
      gwLog.error("Sending to $server failed: ${e.words}")
      Locator.forget()
      Connection.reached(false, why = "Sending to $host failed: ${e.words}.")
      Result.Unreachable
    }
  }

  /** To the team's store when this phone joined one, else through the relay. */
  private suspend fun viaTeam(data: ByteArray, path: String): Result {
    val sent = if (Store.joined != null) Store.send(path, data) else Relay.send(path, data)
    return when (sent) {
      Relay.Sent.LEFT -> Result.Relayed
      Relay.Sent.NOT_LET_IN, Relay.Sent.UNREACHABLE -> Result.Unreachable
      Relay.Sent.REFUSED -> Result.Rejected(400)
    }
  }

  // Sent

  private val sentFile: File get() = File(base, "sent.json")
  private val deletesFile: File get() = File(base, "deletes.json")
  private val pictures: File get() = File(base, "pictures")

  private fun read(file: File): MutableList<JSONObject> = try {
    JSONArray(file.readText()).objects().toMutableList()
  } catch (_: Exception) {
    mutableListOf()
  }

  private fun write(list: List<JSONObject>, file: File) {
    base.mkdirs()
    file.writeText(jsonList(list).toString())
    Bus.post(Bus.OUTBOX)
  }

  /**
   * A card id as grndwrk makes them (n_ and four to twelve letters or digits). Ids come back
   * from the store or the relay, where a teammate's write could put anything; only such an id
   * is ever used as a file name, so a picture never goes outside its folder.
   */
  fun isNodeId(s: String) = Regex("^n_[a-z0-9]{4,12}$").matches(s)

  /** The picture taken with a sent comment, to show when testing its fix. */
  fun picture(node: String): Bitmap? {
    if (!isNodeId(node)) return null
    val f = File(pictures, "$node.png")
    return if (f.exists()) BitmapFactory.decodeFile(f.path) else null
  }

  /** The picture of a waiting comment, from the comment itself. */
  fun picture(file: File): Bitmap? = try {
    val image = JSONObject(file.readText()).str("image") ?: return null
    val bytes = Base64.decode(image.substringAfter(','), Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
  } catch (_: Exception) {
    null
  }

  /** Keep a sent comment, without its picture. The last 200. Through the relay the id is not known yet: kept by its key until its status names it. */
  fun remember(data: ByteArray, id: String, project: String?, relayed: Boolean = false) {
    val entry = try { JSONObject(String(data)) } catch (_: Exception) { return }
    val node = if (isNodeId(id)) id else ""
    val name = if (node.isEmpty()) entry.str("key")?.takeIf { Regex("^[A-Za-z0-9-]{16,64}$").matches(it) }?.let { "key-$it" } else node
    // The picture stays on the phone, beside the list, to show when testing a fix.
    val image = entry.str("image")
    if (image != null && name != null) {
      try {
        pictures.mkdirs()
        File(pictures, "$name.png").writeBytes(Base64.decode(image.substringAfter(','), Base64.DEFAULT))
      } catch (_: Exception) {}
    }
    entry.remove("image")
    if (node.isEmpty()) entry.remove("node") else entry.put("node", node)
    if (relayed) entry.put("relay", true)
    val p = if (relayed) null else project ?: Connection.project
    if (p == null) entry.remove("project") else entry.put("project", p)
    entry.put("sent", iso())
    val kept = (read(sentFile) + entry).takeLast(200)
    write(kept, sentFile)
    // Pictures of comments that fell off the list go too.
    val ids = kept.mapNotNull { it.str("node") }.toSet() + kept.mapNotNull { it.str("key")?.let { k -> "key-$k" } }
    for (f in pictures.listFiles() ?: emptyArray()) if (f.nameWithoutExtension !in ids) f.delete()
  }

  val waiting: List<Item> get() = files.mapNotNull { f -> try { item(JSONObject(f.readText()), f) } catch (_: Exception) { null } }

  val sent: List<Item> get() = read(sentFile).reversed().map { item(it, null) }

  private fun item(c: JSONObject, file: File?): Item {
    val element = c.optJSONObject("element")
    val on = listOfNotNull(element?.str("role"), element?.str("label")?.let { "“${it.take(40)}”" }).joinToString(" ")
    val parts = listOfNotNull(c.str("screen"), on.ifEmpty { null }).toMutableList()
    c.str("status")?.let { if (it != "open") parts += it }
    val node = c.str("node")
    if (!node.isNullOrEmpty()) parts += node
    // What it is called in grndwrk now, when the person edited it there.
    var text = c.str("title") ?: c.str("text") ?: ""
    if (text.isEmpty() && c.optBoolean("on_mac")) text = "Written on the Mac"
    if (node == null && c.optBoolean("relay") && file == null) parts += "at the relay"
    return Item(
      file, node, text, parts.joinToString(" · "), parseIso(c.str("written")), c.str("state"), c.str("fix"), c.str("screen"), c.str("test"),
      c.optJSONArray("steps")?.strings() ?: emptyList(),
      c.optJSONArray("checks")?.let { a ->
        (0 until a.length()).map { i ->
          a.optJSONObject(i)?.let { o -> o.str("kind")?.takeIf { it in setOf("automated", "agent", "outdated") }?.let { Check(it, (o.str("note") ?: "").take(200)) } }
        }
      } ?: emptyList(),
      c.str("check_summary")?.take(200),
    )
  }

  /**
   * The screen the app shows, as the map has it: what it is for and who it is
   * for (each persona's summary and jobs), in lines for the long-press menu.
   * Only from grndwrk on this Mac or the Wi-Fi, never through the relay.
   */
  suspend fun screenAbout(screen: Inspector.Screen): String? {
    if (Connection.state !is Connection.State.Connected) return null
    val server = Locator.url() ?: return null
    val ask = JSONObject().put("screen", screen.name)
    screen.component?.let { ask.put("component", it) }
    val found = try {
      val a = Pairing.post(server, "api/feedback/screen", ask.toString().toByteArray(), 5000)
      if (a.status != 200) return null
      a.json?.optJSONObject("screen") ?: return null
    } catch (_: Why) {
      return null
    }
    val lines = mutableListOf("This screen: ${found.str("title") ?: screen.name}")
    found.str("purpose")?.takeIf { it.isNotEmpty() }?.let { lines += it }
    for (p in found.optJSONArray("personas")?.objects() ?: emptyList()) {
      lines += ""
      lines += "For ${p.str("name") ?: ""}"
      p.str("summary")?.takeIf { it.isNotEmpty() }?.let { lines += it }
      for (job in p.optJSONArray("jobs")?.strings() ?: emptyList()) lines += "• $job"
    }
    return lines.joinToString("\n")
  }

  private val statusFields = listOf("title", "status", "state", "fix", "test", "steps", "checks", "check_summary", "round")

  /**
   * Ask grndwrk what became of the sent comments: their title and status
   * now. Comments deleted there are dropped here too. Only comments sent to
   * the project that answers are asked about.
   */
  suspend fun sync() {
    syncTeam()
    val project = Connection.project ?: return
    val ask = read(sentFile).mapNotNull { c ->
      val id = c.str("node")
      val key = c.str("key")
      if (id.isNullOrEmpty() || key == null || (c.str("project") ?: project) != project) null else JSONObject().put("id", id).put("key", key)
    }
    if (ask.isEmpty()) return
    val server = Locator.url() ?: return
    val answer = try {
      val a = Pairing.post(server, "api/feedback/status", JSONObject().put("comments", jsonList(ask)).toString().toByteArray())
      if (a.status != 200) return
      a.json?.optJSONArray("comments")?.objects() ?: return
    } catch (_: Why) {
      return
    }
    val now = answer.mapNotNull { a -> a.str("id")?.let { it to a } }.toMap()
    val before = readyIds()
    // Read again: something may have changed while asking.
    val next = read(sentFile).mapNotNull { c ->
      val a = c.str("node")?.let { now[it] } ?: return@mapNotNull c
      if (a.optBoolean("gone")) return@mapNotNull null
      for (f in statusFields) if (a.has(f)) c.put(f, a.get(f)) else c.remove(f)
      c
    }
    write(next, sentFile)
    tellNewFixes(next, before)
  }

  private fun readyIds() = read(sentFile).filter { it.str("state") == "ready" }.mapNotNull { it.str("node") }.toSet()

  private fun tellNewFixes(next: List<JSONObject>, before: Set<String>) {
    val ready = next.filter { it.str("state") == "ready" }.mapNotNull { it.str("node") }
    if ((ready.toSet() - before).isNotEmpty()) Bus.post(Bus.NEW_FIXES, mapOf("count" to ready.size))
  }

  /** The status of comments sent through the team's store or relay, by their key: their id in grndwrk once a grndwrk on the team took them, and what became of them. */
  private suspend fun syncTeam() {
    if ((Relay.joined == null && Store.joined == null) || read(sentFile).none { it.optBoolean("relay") }) return
    val fromStore = if (Store.joined != null) Store.statuses() else null
    val fromRelay = if (Relay.joined != null) Relay.statuses() else null
    if (fromStore == null && fromRelay == null) return
    val now = ((fromStore ?: emptyList()) + (fromRelay ?: emptyList())).mapNotNull { a -> a.str("key")?.let { it to a } }.toMap()
    val before = readyIds()
    val next = read(sentFile).map { c ->
      val key = c.str("key")
      val a = if (c.optBoolean("relay") && key != null) now[key] else null
      val id = a?.str("id")
      if (a == null || id == null || !isNodeId(id)) return@map c
      if (c.str("node") == null) {
        // Its picture was kept by its key until now.
        File(pictures, "key-$key.png").renameTo(File(pictures, "$id.png"))
      }
      c.put("node", id)
      for (f in statusFields) if (a.has(f)) c.put(f, a.get(f)) else c.remove(f)
      c
    }
    write(next, sentFile)
    tellNewFixes(next, before)
  }

  /** Sent comments whose fix is built: the ones to test in the app. A fix only proposed is not tested. */
  val toTest: List<Item> get() = sent.filter { it.state == "ready" }

  /**
   * The person tested a fix here: it works (fixed), or not yet (back to
   * grndwrk with a note). With onMac, a reject opens the comment in the map
   * on the Mac, to write there what is still wrong. True when grndwrk took it.
   */
  suspend fun tested(node: String, works: Boolean, note: String = "", onMac: Boolean = false): Boolean {
    val entry = read(sentFile).firstOrNull { it.str("node") == node } ?: return false
    val key = entry.str("key") ?: return false
    // Which round of fixing was tested, as grndwrk last said: a result for an earlier fix never settles a newer one.
    val comment = JSONObject().put("id", node).put("key", key)
    entry.str("round")?.let { comment.put("round", it) }
    val body = JSONObject().put("comments", JSONArray().put(comment)).put("works", works).put("platform", "Android")
    if (note.isNotEmpty()) body.put("note", note)
    if (onMac && !works) body.put("on_mac", true)
    if (!taken(post(body.toString().toByteArray(), "api/feedback/tested"))) return false
    sync()
    Bus.post(Bus.OUTBOX)
    return true
  }

  /** Open the comment in grndwrk on the Mac: in the map when it is open, else in a new tab. True when grndwrk took it. */
  suspend fun showOnMac(node: String): Boolean {
    val entry = read(sentFile).firstOrNull { it.str("node") == node } ?: return false
    val key = entry.str("key") ?: return false
    val body = JSONObject().put("comments", JSONArray().put(JSONObject().put("id", node).put("key", key)))
    return taken(post(body.toString().toByteArray(), "api/feedback/show"))
  }

  enum class Deleted { EVERYWHERE, LATER, ONLY_HERE }

  /** Delete a sent comment here and in grndwrk. When grndwrk is not reachable, it is deleted there once it is. */
  suspend fun deleteSent(node: String): Deleted {
    val list = read(sentFile)
    val entry = list.firstOrNull { it.str("node") == node } ?: return Deleted.ONLY_HERE
    write(list.filter { it.str("node") != node }, sentFile)
    if (isNodeId(node)) File(pictures, "$node.png").delete()
    // Sent before comments had keys: grndwrk would not know it is ours.
    val key = entry.str("key") ?: return Deleted.ONLY_HERE
    val deletes = read(deletesFile)
    deletes += JSONObject().put("id", node).put("key", key).put("project", entry.str("project") ?: "").put("relay", entry.optBoolean("relay"))
    write(deletes, deletesFile)
    return if (flushDeletes()) Deleted.EVERYWHERE else Deleted.LATER
  }

  /** Send the deletes that wait. True when none are left. */
  private suspend fun flushDeletes(): Boolean {
    val deletes = read(deletesFile)
    if (deletes.isEmpty()) return true
    val project = Connection.project
    // To the grndwrk on the Wi-Fi, its own; without one, the ones sent through the relay go there.
    val mine = deletes.filter { d ->
      if (project != null) (d.str("project") ?: "").isEmpty() || d.str("project") == project
      else d.optBoolean("relay") && (Relay.joined != null || Store.joined != null)
    }
    if (mine.isEmpty()) return false
    val ask = mine.map { JSONObject().put("id", it.str("id") ?: "").put("key", it.str("key") ?: "") }
    if (!taken(post(JSONObject().put("comments", jsonList(ask)).toString().toByteArray(), "api/feedback/remove"))) return false
    val done = mine.mapNotNull { it.str("id") }.toSet()
    val left = read(deletesFile).filter { (it.str("id") ?: "") !in done }
    write(left, deletesFile)
    return left.isEmpty()
  }

  // Waiting

  /** Every waiting comment in one file: { "grndwrk": "feedback", "comments": [...] }, in the app's cache for sharing. */
  fun export(): Pair<File, List<File>>? {
    val list = files
    val comments = list.mapNotNull { try { JSONObject(it.readText()) } catch (_: Exception) { null } }
    if (comments.isEmpty()) return null
    val stamp = iso().replace(":", "").replace("Z", "") + "-" + UUID.randomUUID().toString().take(6)
    val folder = File(Env.app.cacheDir, "grndwrk").also { it.mkdirs() }
    // One export at a time: an app given an earlier one never reads a later one under its name.
    folder.listFiles()?.filter { it.name.startsWith("grndwrk-feedback-") }?.forEach { it.delete() }
    val out = File(folder, "grndwrk-feedback-$stamp.json")
    out.writeText(JSONObject().put("grndwrk", "feedback").put("comments", jsonList(comments)).toString())
    return out to list
  }

  fun remove(list: List<File>) {
    list.forEach { it.delete() }
    Bus.post(Bus.OUTBOX)
  }

  /** Send what waits, oldest first. Stops at the first one that cannot go yet. */
  suspend fun flush() {
    if (flushing) return
    flushing = true
    try {
      var sent = 0
      for (file in files) {
        val data = try { file.readBytes() } catch (_: Exception) { continue }
        when (val r = post(data)) {
          is Result.Sent -> { remember(data, r.id, r.project); file.delete(); sent++ }
          Result.Relayed -> { remember(data, "", null, relayed = true); file.delete(); sent++ }
          // Sent, or refused for good: either way it should not be tried again.
          is Result.Rejected -> { file.delete(); sent++ }
          Result.Unreachable, Result.NeedsCode -> return
        }
      }
      flushDeletes()
      if (sent > 0) Bus.post(Bus.OUTBOX, mapOf("sent" to sent))
    } finally {
      flushing = false
    }
  }
}
