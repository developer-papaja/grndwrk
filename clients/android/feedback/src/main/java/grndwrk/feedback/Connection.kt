package grndwrk.feedback

import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URLEncoder

/**
 * Whether grndwrk answers right now. Checked when the app comes to the
 * front, every 15 seconds while it is there, and after every comment sent.
 * The grndwrk button shows it as a dot, and the list of comments says it in words.
 */
internal object Connection {
  sealed class State {
    /** Not checked yet. */
    object Unknown : State()
    data class Connected(val project: String, val host: String) : State()
    /** grndwrk answers on the network, but this phone is not paired with it. */
    data class NeedsCode(val project: String, val host: String) : State()
    /** Not reachable, and why, in plain words. */
    data class Offline(val why: String) : State()
  }

  var state: State = State.Unknown
    private set

  /**
   * The address of the grndwrk that proved it holds this phone's key in the last check
   * (or the Mac itself, from the emulator). Comments, pictures and every other request go
   * only there: another grndwrk on the Wi-Fi may answer, but it gets nothing.
   */
  var proven: String? = null
    private set

  /** Whether requests may go to this address: it proved the key, or it is the Mac from the emulator. */
  fun mayPost(server: String): Boolean = server == proven || isThisMac(server)
  private var timer: Job? = null
  private var checking = false

  /**
   * No grndwrk on this Wi-Fi, but the team's relay takes comments: not offline, as far as the person is concerned.
   * Also while a grndwrk on the Wi-Fi waits to be paired: comments are never held back for that.
   * A phone joined to the team's store too sends there instead.
   */
  val viaRelay: Boolean get() = (state is State.Offline || state is State.NeedsCode) && Relay.usable && Store.joined == null

  /** No grndwrk on this Wi-Fi, or one not paired, and the team's store takes comments. */
  val viaStore: Boolean get() = (state is State.Offline || state is State.NeedsCode) && Store.usable

  /** Where a comment goes when grndwrk on the Wi-Fi cannot take it: the team's store or relay, when this phone joined one. */
  val sendsToTeam: Boolean get() = (state is State.Offline || state is State.NeedsCode) && (Store.joined != null || Relay.joined != null)

  /** Comments go to the team's store now: nothing opens on anyone's Mac from here. */
  val throughStore: Boolean get() = sendsToTeam && Store.joined != null

  /** The way comments go without grndwrk on the Wi-Fi, in words. */
  val teamWay: String get() = if (Store.joined != null) "your team's store" else "your team's relay"

  val project: String? get() = (state as? State.Connected)?.project

  /** The app came to the front. */
  fun resume() {
    Env.scope.launch { check() }
    timer?.cancel()
    timer = Env.scope.launch {
      while (isActive) {
        delay(15_000)
        check()
      }
    }
  }

  /** The app went to the back: no checks until it comes back. */
  fun pause() {
    timer?.cancel()
    timer = null
  }

  /** Ask grndwrk whether it is there. Once it answers, waiting comments go, and the sent ones learn what became of them. */
  suspend fun check() {
    if (checking) return
    checking = true
    try {
      val server = Locator.url()
      if (server == null) {
        set(State.Offline(Locator.problem ?: "No grndwrk found on this Wi-Fi."))
        return throughTeam()
      }
      val host = java.net.URL(server).host
      val first = when (val h = hello(server)) {
        is Hello.Answer -> h.json
        is Hello.Failed -> {
          gwLog.error("Hello to $server failed: ${h.why}")
          Locator.forget()
          set(State.Offline("grndwrk at $host did not answer: ${h.why}."))
          return throughTeam()
        }
      }
      val project = first.str("project") ?: ""
      // This Mac, from the emulator: nothing travels over the network, no key needed.
      if (isThisMac(server) && !first.has("paired")) {
        proven = server
        return set(State.Connected(project, host))
      }
      // Anything on the Wi-Fi can call itself grndwrk. Comments and pictures go
      // only to a grndwrk that proves it holds this phone's key; the key itself
      // is never sent, every request is signed with it instead.
      val key = proves(server, project)
      if (key != null) {
        Pairing.current = key
        proven = server
        return set(State.Connected(project, host))
      }
      Pairing.current = null
      set(State.NeedsCode(project, host))
      // Not paired on the Wi-Fi, but in the team's relay: what waits goes there meanwhile.
      throughTeam()
    } finally {
      checking = false
    }
  }

  /** Away from grndwrk's Wi-Fi, with the team's store or relay joined: what waits goes there, and the status of what went comes back. */
  private suspend fun throughTeam() {
    if (Relay.joined == null && Store.joined == null) return
    if (Store.joined != null) Store.check()
    if (Relay.joined != null) Relay.check()
    Outbox.flush()
    Outbox.sync()
  }

  /** The key this phone keeps for the project, if the grndwrk at this address proves it holds it too. */
  private suspend fun proves(server: String, project: String): String? {
    val key = Pairing.key(project) ?: return null
    val challenge = Pairing.newChallenge()
    val answer = (hello(server, challenge, Pairing.deviceId(key)) as? Hello.Answer)?.json ?: return null
    val proof = answer.str("proof")
    if (proof == null || Pairing.proof(key, challenge) != proof.lowercase()) {
      gwLog.error("${java.net.URL(server).host} did not prove it knows this phone: not the grndwrk it paired with, or it was unpaired")
      return null
    }
    return key
  }

  /** The Mac itself, from the emulator: 10.0.2.2, or localhost through `adb reverse`. */
  fun isThisMac(server: String): Boolean =
    Env.isEmulator && java.net.URL(server).host in setOf("10.0.2.2", "localhost", "127.0.0.1", "::1", "[::1]")

  /** Whether the grndwrk at this address proves it holds the key this phone keeps for its project. */
  suspend fun knowsUs(server: String): Boolean {
    val answer = (hello(server) as? Hello.Answer)?.json ?: return false
    return proves(server, answer.str("project") ?: "") != null
  }

  sealed class Hello {
    class Answer(val json: JSONObject) : Hello()
    class Failed(val why: String) : Hello()
  }

  /** What /api/hello says, or why it said nothing. Never sends the key, only which one, by a hash of it. */
  private suspend fun hello(server: String, challenge: String? = null, device: String? = null): Hello {
    var url = join(server, "api/hello")
    if (challenge != null && device != null) url += "?challenge=${URLEncoder.encode(challenge, "UTF-8")}&device=${URLEncoder.encode(device, "UTF-8")}"
    val a = try {
      Http.call(url, timeoutMs = 4000)
    } catch (e: Why) {
      return Hello.Failed(e.words)
    }
    if (a.status != 200) return Hello.Failed("it answered ${a.status} instead of 200")
    val json = a.json
    if (json == null || !json.optBoolean("grndwrk", false)) return Hello.Failed("something answered, but not grndwrk")
    return Hello.Answer(json)
  }

  /** Whether grndwrk answers at this address: null when it does, or why not. */
  suspend fun probe(server: String): String? = (hello(server) as? Hello.Failed)?.why

  /** grndwrk turned a request down: it does not know this phone (any more). Pair again. */
  fun codeRefused() {
    Pairing.current = null
    Env.scope.launch { check() }
  }

  /**
   * Sending a comment also tells whether grndwrk is there. An answer never makes an address
   * connected by itself: only check() does, once the key is proven. It keeps a connection that
   * was proven, and otherwise asks check() to look again.
   */
  fun reached(yes: Boolean, project: String? = null, why: String? = null) {
    val server = Locator.current
    if (yes && server != null) {
      if (state is State.Connected && mayPost(server)) set(State.Connected(project ?: this.project ?: "", java.net.URL(server).host))
      else Env.scope.launch { check() }
    } else if (!yes && state is State.NeedsCode) {
      // Still there, still waiting to be paired.
    } else if (!yes) {
      set(State.Offline(why ?: Locator.problem ?: "grndwrk stopped answering."))
    }
  }

  private fun set(next: State) {
    val before = state
    state = next
    // Not connected: no address is proven any more.
    if (next !is State.Connected) proven = null
    if (next == before) return
    gwLog.info("State: $next")
    if (next is State.Connected) Locator.remember(next.project)
    Bus.post(Bus.CONNECTION, mapOf("before" to before))
    if (next is State.Connected) {
      Env.scope.launch {
        Outbox.flush()
        Outbox.sync()
      }
    }
  }
}
