#if canImport(UIKit)
import Network
import UIKit
import os

/// Every step of finding and reaching Groundwork, for Console.app: filter on
/// subsystem `GroundworkFeedback`.
let gwLog = Logger(subsystem: "GroundworkFeedback", category: "connection")

// MARK: - Finding Groundwork

/// Where Groundwork runs. Found with Bonjour when `groundwork --lan` runs on a
/// Mac on the same network; in the Simulator, localhost:7777 also works.
///
/// Every advert found is tried in turn until one answers /api/hello, so a
/// stale advert, or another project's Groundwork, cannot hold the phone up.
/// The project the phone was connected to last, or holds a code for, goes first.
@MainActor
enum Locator {
  static var fixed: URL?
  private static var found: URL?
  static var current: URL? { fixed ?? found }
  /// Why the last search found no Groundwork, in plain words. Nil when it found one.
  private(set) static var problem: String?

  private static let lastProjectKey = "GroundworkFeedback.lastProject"
  static func remember(project: String) {
    if !project.isEmpty { UserDefaults.standard.set(project, forKey: lastProjectKey) }
  }

  static func url() async -> URL? {
    if let fixed { return fixed }
    if let found { return found }
    // In the Simulator, Groundwork on this Mac answers at localhost without a
    // search, which also works in an app without NSBonjourServices.
    #if targetEnvironment(simulator) && !GROUNDWORK_NO_LOCALHOST
    if let local = URL(string: "http://localhost:7777"), await Connection.probe(local) == nil {
      gwLog.info("Using Groundwork at localhost:7777")
      found = local
      problem = nil
      return local
    }
    #endif
    if let url = await search() {
      found = url
      problem = nil
      return url
    }
    // GROUNDWORK_NO_LOCALHOST: for testing discovery alone, in the Simulator.
    #if targetEnvironment(simulator) && !GROUNDWORK_NO_LOCALHOST
    gwLog.info("Nothing on the network; trying localhost:7777 in the Simulator")
    return URL(string: "http://localhost:7777")
    #else
    return nil
    #endif
  }

  static func forget() { found = nil }

  private static func search() async -> URL? {
    gwLog.info("Searching for _groundwork._tcp")
    let services: [Browse.Service]
    switch await Browse.run() {
    case .problem(let words):
      gwLog.error("Search ended: \(words, privacy: .public)")
      problem = words
      return nil
    case .found(let list):
      services = list
    }
    guard !services.isEmpty else {
      problem = "No Groundwork found on this Wi-Fi. Is it running with --lan on the Mac, on the same network?"
      gwLog.error("Search found no adverts")
      return nil
    }
    let last = UserDefaults.standard.string(forKey: lastProjectKey)
    let rank = { (s: Browse.Service) -> Int in s.project == last ? 0 : Pairing.code(for: s.project) != nil ? 1 : 2 }
    let ordered = services.sorted { rank($0) < rank($1) }
    gwLog.info("Found \(ordered.count) adverts: \(ordered.map { "\($0.name) [\($0.project)]" }.joined(separator: ", "), privacy: .public)")

    var problems: [String] = []
    // A Groundwork that proves it knows a code this phone keeps comes first:
    // another advert under the same project name cannot.
    var answering: [URL] = []
    for service in ordered {
      switch await Resolve.url(of: service.endpoint) {
      case .failure(let why):
        gwLog.error("\(service.name, privacy: .public): could not resolve, \(why.words, privacy: .public)")
        problems.append("\u{201C}\(service.name)\u{201D}: \(why.words)")
      case .success(let url):
        gwLog.info("\(service.name, privacy: .public) resolved to \(url.absoluteString, privacy: .public)")
        if let why = await Connection.probe(url) {
          gwLog.error("\(service.name, privacy: .public) at \(url.absoluteString, privacy: .public): \(why, privacy: .public)")
          problems.append("\u{201C}\(service.name)\u{201D} at \(url.host ?? ""): \(why)")
          continue
        }
        if await Connection.knowsOurCode(url) {
          gwLog.info("Using \(service.name, privacy: .public) at \(url.absoluteString, privacy: .public): it knows our code")
          return url
        }
        answering.append(url)
      }
    }
    if let url = answering.first {
      gwLog.info("Using \(url.absoluteString, privacy: .public): none proved a code this phone keeps")
      return url
    }
    problem = "Found Groundwork on the network, but none answered.\n" + problems.joined(separator: "\n")
    return nil
  }
}

/// An error in words, for the phone and the log.
struct Why: Error {
  let words: String
}

// MARK: - Browsing

/// One Bonjour search. Collects every advert that shows up, waiting a moment
/// after the first for the rest. Every callback runs on the main queue.
private final class Browse: @unchecked Sendable {
  struct Service {
    let name: String
    let project: String
    let endpoint: NWEndpoint
  }
  enum Outcome {
    case found([Service])
    case problem(String)
  }

  /// How long to wait for a first answer: a busy network can be slow.
  private static let timeout: TimeInterval = 6
  /// After the first advert, how long to wait for others.
  private static let settle: TimeInterval = 1

  static func run() async -> Outcome {
    await withCheckedContinuation { (done: CheckedContinuation<Outcome, Never>) in
      Browse { done.resume(returning: $0) }.start()
    }
  }

  private let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_groundwork._tcp", domain: nil), using: .tcp)
  private var services: [Service] = []
  private var settling = false
  private var finished = false
  private var waitingWhy: String?
  private let done: (Outcome) -> Void

  private init(done: @escaping (Outcome) -> Void) {
    self.done = done
  }

  func start() {
    browser.browseResultsChangedHandler = { [self] results, _ in
      services = results.compactMap { result in
        guard case .service(let name, _, _, _) = result.endpoint else { return nil }
        var project = ""
        if case .bonjour(let txt) = result.metadata { project = txt["project"] ?? "" }
        return Service(name: name, project: project, endpoint: result.endpoint)
      }
      guard !services.isEmpty, !settling else { return }
      settling = true
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.settle) { [self] in finish(.found(services)) }
    }
    browser.stateUpdateHandler = { [self] state in
      switch state {
      case .ready:
        gwLog.info("Bonjour search ready")
      case .waiting(let error):
        // What a denied Local Network permission looks like. Nothing will come until it is allowed.
        if Self.isPolicyDenied(error) {
          finish(.problem("Local Network access is off for this app. Turn it on in Settings > Privacy & Security > Local Network, then come back."))
        } else {
          gwLog.error("Bonjour search waiting: \(String(describing: error), privacy: .public)")
          waitingWhy = "The Bonjour search is stuck: \(error.localizedDescription)"
        }
      case .failed(let error):
        finish(.problem(Self.isPolicyDenied(error)
          ? "Local Network access is off for this app. Turn it on in Settings > Privacy & Security > Local Network, then come back."
          : "The Bonjour search failed: \(error.localizedDescription)"))
      default:
        break
      }
    }
    browser.start(queue: .main)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout) { [self] in
      finish(services.isEmpty && waitingWhy != nil ? .problem(waitingWhy!) : .found(services))
    }
  }

  private static func isPolicyDenied(_ error: NWError) -> Bool {
    if case .dns(let code) = error { return code == DNSServiceErrorType(kDNSServiceErr_PolicyDenied) }
    return false
  }

  private func finish(_ outcome: Outcome) {
    guard !finished else { return }
    finished = true
    browser.cancel()
    done(outcome)
  }
}

// MARK: - Resolving

/// Turn an advert into an address URLSession can use: connect once and read
/// the address the connection went to. IPv4 first, since it makes a plain URL;
/// when that does not work, any address, IPv6 included.
@MainActor
private enum Resolve {
  static func url(of endpoint: NWEndpoint) async -> Result<URL, Why> {
    switch await attempt(endpoint, ipv4: true) {
    case .success(let url): return .success(url)
    case .failure(let first):
      gwLog.info("IPv4 did not work (\(first.words, privacy: .public)), trying any address")
      return await attempt(endpoint, ipv4: false)
    }
  }

  private static func attempt(_ endpoint: NWEndpoint, ipv4: Bool) async -> Result<URL, Why> {
    await withCheckedContinuation { (done: CheckedContinuation<Result<URL, Why>, Never>) in
      let params = NWParameters.tcp
      if ipv4 { (params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4 }
      let c = NWConnection(to: endpoint, using: params)
      var finished = false
      let finish = { (result: Result<URL, Why>) in
        guard !finished else { return }
        finished = true
        c.cancel()
        done.resume(returning: result)
      }
      c.stateUpdateHandler = { state in
        switch state {
        case .ready:
          guard case .hostPort(let host, let port) = c.currentPath?.remoteEndpoint, let url = Self.url(host, port) else {
            return finish(.failure(Why(words: "connected, but without an address")))
          }
          finish(.success(url))
        case .waiting(let error):
          // Connection refused, as from a stale advert with nothing behind it, waits here rather than failing.
          finish(.failure(Why(words: Self.words(error))))
        case .failed(let error):
          finish(.failure(Why(words: Self.words(error))))
        default:
          break
        }
      }
      c.start(queue: .main)
      DispatchQueue.main.asyncAfter(deadline: .now() + 4) { finish(.failure(Why(words: "no answer within 4 seconds"))) }
    }
  }

  nonisolated private static func url(_ host: NWEndpoint.Host, _ port: NWEndpoint.Port) -> URL? {
    switch host {
    case .ipv4(let a):
      var name = "\(a)"
      if let cut = name.firstIndex(of: "%") { name = String(name[..<cut]) }
      return URL(string: "http://\(name):\(port.rawValue)")
    case .ipv6(let a):
      // A link-local address needs its interface, written %25 inside a URL.
      let name = "\(a)".replacingOccurrences(of: "%", with: "%25")
      return URL(string: "http://[\(name)]:\(port.rawValue)")
    case .name(let name, _):
      return URL(string: "http://\(name):\(port.rawValue)")
    @unknown default:
      return nil
    }
  }

  nonisolated private static func words(_ error: NWError) -> String {
    if case .posix(let code) = error {
      switch code {
      case .ECONNREFUSED: return "nothing is listening there (a Groundwork that has stopped?)"
      case .EHOSTUNREACH, .ENETUNREACH: return "the Mac cannot be reached from this network"
      case .ETIMEDOUT: return "no answer in time"
      default: break
      }
    }
    return error.localizedDescription
  }
}
#endif
