#if canImport(UIKit)
import CryptoKit
import UIKit
import os

/// Whether grndwrk answers right now. Checked when the app comes to the
/// front, every 15 seconds while it is there, and after every comment sent.
/// The grndwrk button shows it as a dot, and the list of comments says it in words.
@MainActor
enum Connection {
  enum State: Equatable {
    /// Not checked yet.
    case unknown
    case connected(project: String, host: String)
    /// grndwrk answers on the network, but wants the pairing code it shows in the terminal.
    case needsCode(project: String, host: String)
    /// Not reachable, and why, in plain words.
    case offline(String)
  }

  static let changed = Notification.Name("GrndwrkFeedback.connection")
  private(set) static var state: State = .unknown
  private static var timer: Timer?
  private static var checking = false

  /// No grndwrk on this Wi-Fi, but the team's relay takes comments: not offline, as far as the person is concerned.
  static var viaRelay: Bool {
    if case .offline = state { return Relay.usable }
    return false
  }

  static var project: String? {
    if case .connected(let project, _) = state { return project }
    return nil
  }

  static func start() {
    Pairing.dropCodes()
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated { resume() }
    }
    NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated {
        timer?.invalidate()
        timer = nil
      }
    }
    resume()
  }

  private static func resume() {
    Task { await check() }
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
      Task { @MainActor in await check() }
    }
  }

  /// Ask grndwrk whether it is there. Once it answers, waiting comments go,
  /// and the sent ones learn what became of them.
  static func check() async {
    guard !checking else { return }
    checking = true
    defer { checking = false }
    guard let server = await Locator.url() else {
      set(.offline(Locator.problem ?? "No grndwrk found on this Wi-Fi."))
      return await throughRelay()
    }
    let host = server.host ?? ""
    let first: [String: Any]
    switch await hello(server) {
    case .answer(let answer): first = answer
    case .failed(let why):
      gwLog.error("Hello to \(server.absoluteString, privacy: .public) failed: \(why, privacy: .public)")
      Locator.forget()
      set(.offline("grndwrk at \(host) did not answer: \(why)."))
      return await throughRelay()
    }
    let project = first["project"] as? String ?? ""
    // This Mac, from the Simulator: nothing travels over the network, no key needed.
    if isThisMac(server), first["paired"] == nil { return set(.connected(project: project, host: host)) }
    // Anything on the Wi-Fi can call itself grndwrk. Comments and pictures go
    // only to a grndwrk that proves it holds this phone's key; the key itself
    // is never sent, every request is signed with it instead.
    if let key = await proves(server, project: project) {
      Pairing.current = key
      return set(.connected(project: project, host: host))
    }
    Pairing.current = nil
    set(.needsCode(project: project, host: host))
  }

  /// Away from grndwrk's Wi-Fi, with the team's relay joined: what waits goes there, and the status of what went comes back.
  private static func throughRelay() async {
    guard Relay.joined != nil else { return }
    await Relay.check()
    await Outbox.flush()
    await Outbox.sync()
  }

  /// The key this phone keeps for the project, if the grndwrk at this address proves it holds it too.
  private static func proves(_ server: URL, project: String) async -> String? {
    guard let key = Pairing.key(for: project) else { return nil }
    let challenge = Pairing.newChallenge()
    guard case .answer(let answer) = await hello(server, challenge: challenge, device: Pairing.deviceId(key)) else { return nil }
    guard let proof = answer["proof"] as? String, Pairing.proof(key, challenge) == proof.lowercased() else {
      gwLog.error("\(server.host ?? "", privacy: .public) did not prove it knows this phone: not the grndwrk it paired with, or it was unpaired")
      return nil
    }
    return key
  }

  /// localhost, which in the Simulator is the Mac itself.
  static func isThisMac(_ server: URL) -> Bool {
    #if targetEnvironment(simulator)
    return ["localhost", "127.0.0.1", "::1"].contains(server.host ?? "")
    #else
    return false
    #endif
  }

  /// Whether the grndwrk at this address proves it holds the key this phone keeps for its project.
  static func knowsUs(_ server: URL) async -> Bool {
    guard case .answer(let answer) = await hello(server) else { return false }
    return await proves(server, project: answer["project"] as? String ?? "") != nil
  }

  enum Hello {
    case answer([String: Any])
    case failed(String)
  }

  /// What /api/hello says, or why it said nothing. Never sends the key, only which one, by a hash of it.
  private static func hello(_ server: URL, challenge: String? = nil, device: String? = nil) async -> Hello {
    var parts = URLComponents(url: server.appendingPathComponent("api/hello"), resolvingAgainstBaseURL: false)
    if let challenge, let device { parts?.queryItems = [URLQueryItem(name: "challenge", value: challenge), URLQueryItem(name: "device", value: device)] }
    guard let url = parts?.url else { return .failed("a bad address") }
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    let body: Data
    let response: URLResponse
    do {
      (body, response) = try await URLSession.shared.data(for: request)
    } catch {
      return .failed(words(error))
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let answer = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    guard status == 200 else { return .failed("it answered \(status) instead of 200") }
    guard let answer, answer["grndwrk"] as? Bool == true else { return .failed("something answered, but not grndwrk") }
    return .answer(answer)
  }

  /// Whether grndwrk answers at this address: nil when it does, or why not.
  static func probe(_ server: URL) async -> String? {
    if case .failed(let why) = await hello(server) { return why }
    return nil
  }

  /// A failed request in plain words.
  static func words(_ error: Error) -> String {
    guard let error = error as? URLError else { return error.localizedDescription }
    switch error.code {
    case .timedOut: return "no answer within 4 seconds"
    case .cannotConnectToHost: return "nothing is listening there (a grndwrk that has stopped?)"
    case .cannotFindHost, .dnsLookupFailed: return "its address could not be found"
    case .notConnectedToInternet, .networkConnectionLost: return "this phone is not on a network"
    case .appTransportSecurityRequiresSecureConnection: return "blocked by App Transport Security (add NSAllowsLocalNetworking to Info.plist)"
    default: return error.localizedDescription
    }
  }

  /// grndwrk turned a request down: it does not know this phone (any more). Pair again.
  static func codeRefused() {
    Pairing.current = nil
    Task { await check() }
  }

  /// Sending a comment also tells whether grndwrk is there.
  static func reached(_ yes: Bool, project: String? = nil, why: String? = nil) {
    if yes, let server = Locator.current {
      set(.connected(project: project ?? self.project ?? "", host: server.host ?? ""))
    } else if !yes, case .needsCode = state {
      // Still there, still waiting for the code.
    } else if !yes {
      set(.offline(why ?? Locator.problem ?? "grndwrk stopped answering."))
    }
  }

  private static func set(_ next: State) {
    let before = state
    state = next
    guard next != before else { return }
    gwLog.info("State: \(String(describing: next), privacy: .public)")
    if case .connected(let project, _) = next { Locator.remember(project: project) }
    NotificationCenter.default.post(name: changed, object: nil, userInfo: ["before": before])
    if case .connected = next {
      Task {
        await Outbox.flush()
        await Outbox.sync()
      }
    }
  }
}
/// Pairing with `grndwrk --lan`: the person allows this phone in the map on
/// the Mac (or types the code the terminal shows, once), and grndwrk gives
/// the phone its own long random key, kept here per project. The key is
/// never sent again: grndwrk proves it holds it, and every request is signed
/// with it, so a recording or a fake grndwrk on the Wi-Fi gets nothing to reuse.
@MainActor
enum Pairing {
  private static let storeKey = "GrndwrkFeedback.keys"
  /// The key of the grndwrk this phone talks to, which signs every request.
  static var current: String?

  private static var keys: [String: String] {
    get { UserDefaults.standard.dictionary(forKey: storeKey) as? [String: String] ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: storeKey) }
  }

  static func key(for project: String) -> String? { keys[project] }

  static func save(_ key: String, for project: String) {
    guard key.count == 64, key.allSatisfy(\.isHexDigit) else { return }
    keys[project] = key.lowercased()
  }

  static func forget(_ project: String) { keys[project] = nil }

  /// Codes kept before keys: grndwrk no longer takes them, so each phone pairs once more.
  static func dropCodes() { UserDefaults.standard.removeObject(forKey: "GrndwrkFeedback.codes") }

  /// A one-time word for /api/hello to prove the key with.
  static func newChallenge() -> String {
    (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "")
  }

  /// Which key this phone signs with, as grndwrk knows it: a hash, so it tells nobody the key.
  static func deviceId(_ key: String) -> String {
    String(hex(SHA256.hash(data: Data("grndwrk-device:\(key)".utf8))).prefix(32))
  }

  static func proof(_ key: String, _ challenge: String) -> String {
    hex(HMAC<SHA256>.authenticationCode(for: Data("grndwrk-hello:\(challenge)".utf8), using: SymmetricKey(data: Data(key.utf8))))
  }

  private static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
    bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// The four digits grndwrk shows next to this request in the map, worked out the same way from the secret.
  static func checkDigits(_ secret: String) -> String {
    let hash = hex(SHA256.hash(data: Data("grndwrk-pair:\(secret)".utf8)))
    let n = UInt64(hash.prefix(8), radix: 16) ?? 0
    return String(format: "%04d", n % 10000)
  }

  /// Signs a request with the key, the same lines in the same order as src/server/devices.ts:
  /// the method, the path, the time, a nonce and a hash of the body. Call it after setting the body.
  static func sign(_ request: inout URLRequest) {
    guard let current, let url = request.url else { return }
    let method = (request.httpMethod ?? "GET").uppercased()
    let time = String(Int64(Date().timeIntervalSince1970 * 1000))
    let nonce = UUID().uuidString + UUID().uuidString.prefix(8)
    let body = hex(SHA256.hash(data: request.httpBody ?? Data()))
    let line = "grndwrk-request\n\(method)\n\(url.path)\n\(time)\n\(nonce)\n\(body)"
    let mac = hex(HMAC<SHA256>.authenticationCode(for: Data(line.utf8), using: SymmetricKey(data: Data(current.utf8))))
    request.setValue(deviceId(current), forHTTPHeaderField: "X-Grndwrk-Device")
    request.setValue(time, forHTTPHeaderField: "X-Grndwrk-Time")
    request.setValue(nonce, forHTTPHeaderField: "X-Grndwrk-Nonce")
    request.setValue(mac, forHTTPHeaderField: "X-Grndwrk-Signature")
  }

  /// The code typed from the terminal, for a key of this phone's own. Wrong codes lock out for a while.
  static func pair(code: String) async -> String? {
    guard let server = await Locator.url() else { return nil }
    let answer = await call(server, "api/pair/code", ["code": code, "device": UIDevice.current.name])
    return answer?["key"] as? String
  }

  enum Asked { case allowed(key: String, digits: String), denied, noBrowser, unanswered }

  /// Ask the person at the Mac to allow this phone. grndwrk shows the
  /// request in the map with four digits, which `asking` gets too, to show
  /// here. Once allowed, this phone's key comes back; it is kept only after the
  /// person confirms they allowed it next to those digits. Waits up to three minutes.
  static func ask(project: String, asking: (String) -> Void) async -> Asked {
    guard let server = await Locator.url() else { return .unanswered }
    // Known only to this phone: grndwrk tells the key to whoever holds it.
    let secret = UUID().uuidString + "-" + UUID().uuidString.prefix(8)
    let digits = checkDigits(secret)
    let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
      ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ""
    guard let asked = await call(server, "api/pair", ["request": secret, "device": UIDevice.current.name, "app": app]) else { return .unanswered }
    if asked["browser"] as? Bool == false { return .noBrowser }
    asking(digits)
    for _ in 0..<90 {
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      guard let answer = await call(server, "api/pair/status", ["request": secret]) else { continue }
      switch answer["status"] as? String {
      case "allowed":
        guard let key = answer["key"] as? String else { return .unanswered }
        return .allowed(key: key, digits: digits)
      case "denied": return .denied
      case "waiting": continue
      default: return .unanswered
      }
    }
    return .unanswered
  }

  private static func call(_ server: URL, _ path: String, _ body: [String: String]) async -> [String: Any]? {
    var request = URLRequest(url: server.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    request.timeoutInterval = 6
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      [200, 202].contains((response as? HTTPURLResponse)?.statusCode ?? 0) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}
#endif
