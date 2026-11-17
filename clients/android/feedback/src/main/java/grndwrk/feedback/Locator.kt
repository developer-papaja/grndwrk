package grndwrk.feedback

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import java.net.Inet6Address

/**
 * Where grndwrk runs. Found with NSD (Bonjour) when `grndwrk --lan` runs on a
 * Mac on the same network; in the emulator, the Mac also answers at 10.0.2.2,
 * and at localhost after `adb reverse tcp:7777 tcp:7777`.
 *
 * Every advert found is tried in turn until one answers /api/hello, so a
 * stale advert, or another project's grndwrk, cannot hold the phone up.
 * The project the phone was connected to last, or holds a key for, goes first.
 */
internal object Locator {
  var fixed: String? = null
  private var found: String? = null
  val current: String? get() = fixed ?: found
  /** Why the last search found no grndwrk, in plain words. Null when it found one. */
  var problem: String? = null
    private set

  private const val LAST_PROJECT = "lastProject"
  fun remember(project: String) {
    if (project.isNotEmpty()) Env.prefs.edit().putString(LAST_PROJECT, project).apply()
  }

  /** The Mac, as the emulator reaches it. */
  private val emulatorHosts = listOf("http://10.0.2.2:7777", "http://localhost:7777")

  suspend fun url(): String? {
    fixed?.let { return it }
    found?.let { return it }
    // In the emulator, grndwrk on this Mac answers without a search.
    if (Env.isEmulator) {
      for (local in emulatorHosts) {
        if (Connection.probe(local) == null) {
          gwLog.info("Using grndwrk at $local")
          found = local
          problem = null
          return local
        }
      }
    }
    search()?.let {
      found = it
      problem = null
      return it
    }
    if (Env.isEmulator) {
      gwLog.info("Nothing on the network; trying 10.0.2.2:7777 in the emulator")
      problem = problem ?: "grndwrk does not answer at 10.0.2.2:7777. Is it running on the Mac, on that port?"
      return null
    }
    return null
  }

  fun forget() { found = null }

  private class Service(val name: String, val project: String, val info: NsdServiceInfo)

  private suspend fun search(): String? {
    gwLog.info("Searching for _grndwrk._tcp")
    val services = browse() ?: return null
    if (services.isEmpty()) {
      problem = "No grndwrk found on this Wi-Fi. Is it running with --lan on the Mac, on the same network?"
      gwLog.error("Search found no adverts")
      return null
    }
    val last = Env.prefs.getString(LAST_PROJECT, null)
    val ordered = services.sortedBy { if (it.project == last) 0 else if (Pairing.key(it.project) != null) 1 else 2 }
    gwLog.info("Found ${ordered.size} adverts: ${ordered.joinToString { "${it.name} [${it.project}]" }}")
    val problems = mutableListOf<String>()
    // A grndwrk that proves it holds this phone's key comes first:
    // another advert under the same project name cannot (relaying its proof
    // gets it nothing: requests are signed, never carry the key).
    val answering = mutableListOf<String>()
    for (s in ordered) {
      val url = resolve(s.info)
      if (url == null) {
        problems += "“${s.name}”: could not be resolved"
        continue
      }
      gwLog.info("${s.name} resolved to $url")
      val why = Connection.probe(url)
      if (why != null) {
        gwLog.error("${s.name} at $url: $why")
        problems += "“${s.name}” at ${java.net.URL(url).host}: $why"
        continue
      }
      if (Connection.knowsUs(url)) {
        gwLog.info("Using ${s.name} at $url: it knows this phone")
        return url
      }
      answering += url
    }
    answering.firstOrNull()?.let {
      gwLog.info("Using $it: none proved it knows this phone")
      return it
    }
    problem = "Found grndwrk on the network, but none answered.\n" + problems.joinToString("\n")
    return null
  }

  /** One search: every advert that shows up, waiting a moment after the first for the rest. */
  private suspend fun browse(): List<Service>? {
    val nsd = Env.app.getSystemService(Context.NSD_SERVICE) as NsdManager
    // Some phones drop multicast while the screen is on and nothing holds it.
    val wifi = Env.app.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val lock = try { wifi?.createMulticastLock("grndwrk")?.apply { setReferenceCounted(false); acquire() } } catch (_: SecurityException) { null }
    val seen = mutableListOf<NsdServiceInfo>()
    val first = CompletableDeferred<Unit>()
    val failed = CompletableDeferred<String>()
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) { gwLog.info("NSD search ready") }
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onServiceFound(info: NsdServiceInfo) {
        synchronized(seen) { if (seen.none { it.serviceName == info.serviceName }) seen += info }
        first.complete(Unit)
      }
      override fun onServiceLost(info: NsdServiceInfo) {
        synchronized(seen) { seen.removeAll { it.serviceName == info.serviceName } }
      }
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { failed.complete("The network search could not start (error $errorCode).") }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
    }
    try {
      nsd.discoverServices("_grndwrk._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
      val outcome = withTimeoutOrNull(6000) {
        kotlinx.coroutines.selects.select<String?> {
          first.onAwait { null }
          failed.onAwait { it }
        }
      }
      if (outcome != null) {
        problem = outcome
        return null
      }
      // After the first advert, a moment for the others.
      delay(1000)
    } finally {
      try { nsd.stopServiceDiscovery(listener) } catch (_: Exception) {}
      lock?.release()
    }
    val list = synchronized(seen) { seen.toList() }
    // The project's name is in the advert's TXT record, which comes with resolving.
    return list.map { Service(it.serviceName, "", it) }.map { s ->
      val resolved = resolveInfo(s.info)
      Service(s.name, resolved?.attributes?.get("project")?.let { String(it) } ?: "", resolved ?: s.info)
    }
  }

  private suspend fun resolveInfo(info: NsdServiceInfo): NsdServiceInfo? {
    if (info.host != null) return info
    val nsd = Env.app.getSystemService(Context.NSD_SERVICE) as NsdManager
    val done = CompletableDeferred<NsdServiceInfo?>()
    @Suppress("DEPRECATION")
    nsd.resolveService(info, object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { done.complete(null) }
      override fun onServiceResolved(serviceInfo: NsdServiceInfo) { done.complete(serviceInfo) }
    })
    return withTimeoutOrNull(4000) { done.await() }
  }

  /** An advert as an address: IPv4 first, since it makes a plain URL. */
  private suspend fun resolve(info: NsdServiceInfo): String? {
    val r = resolveInfo(info) ?: return null
    val addresses = if (Build.VERSION.SDK_INT >= 34) r.hostAddresses else listOfNotNull(@Suppress("DEPRECATION") r.host)
    val host = addresses.firstOrNull { it !is Inet6Address } ?: addresses.firstOrNull() ?: return null
    val name = host.hostAddress ?: return null
    return if (host is Inet6Address) "http://[${name.replace("%", "%25")}]:${r.port}" else "http://$name:${r.port}"
  }
}
