#if canImport(UIKit)
import Network
import UIKit

// MARK: - Finding Groundwork

/// Where Groundwork runs. Found with Bonjour when `groundwork --lan` runs on a
/// Mac on the same network; in the Simulator, localhost:7777 also works.
@MainActor
enum Locator {
  static var fixed: URL?
  private static var found: URL?
  static var current: URL? { fixed ?? found }

  static func url() async -> URL? {
    if let fixed { return fixed }
    if let found { return found }
    if let url = await discover(timeout: 2.5) {
      found = url
      return url
    }
    // GROUNDWORK_NO_LOCALHOST: for testing discovery alone, in the Simulator.
    #if targetEnvironment(simulator) && !GROUNDWORK_NO_LOCALHOST
    return URL(string: "http://localhost:7777")
    #else
    return nil
    #endif
  }

  static func forget() { found = nil }

  /// Browse for _groundwork._tcp and turn the first answer into an address.
  private static func discover(timeout: TimeInterval) async -> URL? {
    await withCheckedContinuation { (done: CheckedContinuation<URL?, Never>) in
      Discovery(timeout: timeout) { done.resume(returning: $0) }.start()
    }
  }
}

/// One search for Groundwork on the network. Every callback runs on the main queue.
private final class Discovery: @unchecked Sendable {
  private let browser = NWBrowser(for: .bonjour(type: "_groundwork._tcp", domain: nil), using: .tcp)
  private var connection: NWConnection?
  private var finished = false
  private let timeout: TimeInterval
  private let done: (URL?) -> Void

  init(timeout: TimeInterval, done: @escaping (URL?) -> Void) {
    self.timeout = timeout
    self.done = done
  }

  func start() {
    browser.browseResultsChangedHandler = { [self] results, _ in
      guard connection == nil, let result = results.first else { return }
      connect(to: result.endpoint)
    }
    browser.stateUpdateHandler = { [self] state in
      if case .failed = state { finish(nil) }
    }
    browser.start(queue: .main)
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [self] in finish(nil) }
  }

  /// Connect once to learn the Mac's IPv4 address and port.
  private func connect(to endpoint: NWEndpoint) {
    let params = NWParameters.tcp
    (params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
    let c = NWConnection(to: endpoint, using: params)
    connection = c
    c.stateUpdateHandler = { [self] state in
      switch state {
      case .ready:
        guard case .hostPort(let host, let port) = c.currentPath?.remoteEndpoint else { return finish(nil) }
        var name = "\(host)"
        if let cut = name.firstIndex(of: "%") { name = String(name[..<cut]) }
        finish(URL(string: "http://\(name):\(port.rawValue)"))
      case .failed, .cancelled:
        finish(nil)
      default:
        break
      }
    }
    c.start(queue: .main)
  }

  private func finish(_ url: URL?) {
    guard !finished else { return }
    finished = true
    browser.cancel()
    connection?.cancel()
    done(url)
  }
}
#endif
