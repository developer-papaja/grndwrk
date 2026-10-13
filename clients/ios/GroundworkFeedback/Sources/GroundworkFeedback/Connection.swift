#if canImport(UIKit)
import CryptoKit
import UIKit
import os

/// Whether Groundwork answers right now. Checked when the app comes to the
/// front, every 15 seconds while it is there, and after every comment sent.
/// The Groundwork button shows it as a dot, and the list of comments says it in words.
@MainActor
enum Connection {
  enum State: Equatable {
    /// Not checked yet.
    case unknown
    case connected(project: String, host: String)
    /// Groundwork answers on the network, but wants the pairing code it shows in the terminal.
    case needsCode(project: String, host: String)
    /// Not reachable, and why, in plain words.
    case offline(String)
  }

  static let changed = Notification.Name("GroundworkFeedback.connection")
  private(set) static var state: State = .unknown
  private static var timer: Timer?
  private static var checking = false

  static var project: String? {
    if case .connected(let project, _) = state { return project }
    return nil
  }

  static func start() {
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

  /// Ask Groundwork whether it is there. Once it answers, waiting comments go,
  /// and the sent ones learn what became of them.
  static func check() async {
    guard !checking else { return }
    checking = true
    defer { checking = false }
    guard let server = await Locator.url() else {
      return set(.offline(Locator.problem ?? "No Groundwork found on this Wi-Fi."))
    }
    let host = server.host ?? ""
    // Never send the code first: anything on the Wi-Fi can call itself
    // Groundwork. Groundwork proves it knows the code, and only then does
    // this phone send it, and comments and pictures with it.
    let challenge = Pairing.newChallenge()
    let first: [String: Any]
    switch await hello(server, challenge: challenge) {
    case .answer(let answer): first = answer
    case .failed(let why):
      gwLog.error("Hello to \(server.absoluteString, privacy: .public) failed: \(why, privacy: .public)")
      Locator.forget()
      return set(.offline("Groundwork at \(host) did not answer: \(why)."))
    }
    let project = first["project"] as? String ?? ""
    // This Mac, from the Simulator: nothing travels over the network, no code needed.
    if isThisMac(server), first["paired"] == nil { return set(.connected(project: project, host: host)) }
    if let code = Pairing.proven(by: first["proof"] as? String, challenge: challenge, project: project) {
      Pairing.current = code
      Pairing.save(code, for: project)
      return set(.connected(project: project, host: host))
    }
    if first["proof"] == nil { gwLog.error("\(host, privacy: .public) gave no proof: an older Groundwork, or not Groundwork") }
    Pairing.current = nil
    set(.needsCode(project: project, host: host))
  }

  /// localhost, which in the Simulator is the Mac itself.
  static func isThisMac(_ server: URL) -> Bool {
    #if targetEnvironment(simulator)
    return ["localhost", "127.0.0.1", "::1"].contains(server.host ?? "")
    #else
    return false
    #endif
  }

  /// Whether the Groundwork at this address proves it knows a code this phone keeps.
  static func knowsOurCode(_ server: URL) async -> Bool {
    let challenge = Pairing.newChallenge()
    guard case .answer(let answer) = await hello(server, challenge: challenge) else { return false }
    return Pairing.proven(by: answer["proof"] as? String, challenge: challenge, project: answer["project"] as? String ?? "") != nil
  }

  enum Hello {
    case answer([String: Any])
    case failed(String)
  }

  /// What /api/hello says, or why it said nothing. Never sends the code.
  private static func hello(_ server: URL, challenge: String? = nil) async -> Hello {
    var parts = URLComponents(url: server.appendingPathComponent("api/hello"), resolvingAgainstBaseURL: false)
    if let challenge { parts?.queryItems = [URLQueryItem(name: "challenge", value: challenge)] }
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
    guard let answer, answer["groundwork"] as? Bool == true else { return .failed("something answered, but not Groundwork") }
    return .answer(answer)
  }

  /// Whether Groundwork answers at this address: nil when it does, or why not.
  static func probe(_ server: URL) async -> String? {
    if case .failed(let why) = await hello(server) { return why }
    return nil
  }

  /// A failed request in plain words.
  static func words(_ error: Error) -> String {
    guard let error = error as? URLError else { return error.localizedDescription }
    switch error.code {
    case .timedOut: return "no answer within 4 seconds"
    case .cannotConnectToHost: return "nothing is listening there (a Groundwork that has stopped?)"
    case .cannotFindHost, .dnsLookupFailed: return "its address could not be found"
    case .notConnectedToInternet, .networkConnectionLost: return "this phone is not on a network"
    case .appTransportSecurityRequiresSecureConnection: return "blocked by App Transport Security (add NSAllowsLocalNetworking to Info.plist)"
    default: return error.localizedDescription
    }
  }

  /// Groundwork turned a request down for want of the code: ask for it again.
  static func codeRefused() {
    Pairing.current = nil
    Task { await check() }
  }

  /// Sending a comment also tells whether Groundwork is there.
  static func reached(_ yes: Bool, project: String? = nil, why: String? = nil) {
    if yes, let server = Locator.current {
      set(.connected(project: project ?? self.project ?? "", host: server.host ?? ""))
    } else if !yes, case .needsCode = state {
      // Still there, still waiting for the code.
    } else if !yes {
      set(.offline(why ?? Locator.problem ?? "Groundwork stopped answering."))
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
/// The pairing code `groundwork --lan` prints, entered once per project and
/// kept on the device. Sent with every request on the network.
@MainActor
enum Pairing {
  static let header = "X-Groundwork-Code"
  private static let key = "GroundworkFeedback.codes"
  /// The code Groundwork accepted last, sent with every request.
  static var current: String?

  private static var codes: [String: String] {
    get { UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: key) }
  }

  static func code(for project: String) -> String? { codes[project] }

  static func save(_ code: String, for project: String) {
    let clean = code.uppercased().filter { $0.isLetter || $0.isNumber }
    guard !clean.isEmpty else { return }
    codes[project] = clean
  }

  static func forget(_ project: String) { codes[project] = nil }

  /// A one-time word for /api/hello to prove the code with.
  static func newChallenge() -> String {
    (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "")
  }

  /// The code this phone keeps that Groundwork's proof was made with, if any:
  /// the one in use, the one kept for this project, then any other.
  static func proven(by proof: String?, challenge: String, project: String) -> String? {
    guard let proof, !proof.isEmpty else { return nil }
    var tried = Set<String>()
    for code in [current, code(for: project)].compactMap({ $0 }) + codes.values.sorted() where tried.insert(code).inserted {
      if self.proof(code, challenge) == proof.lowercased() { return code }
    }
    return nil
  }

  private static func proof(_ code: String, _ challenge: String) -> String {
    let mac = HMAC<SHA256>.authenticationCode(for: Data("groundwork-hello:\(challenge)".utf8), using: SymmetricKey(data: Data(code.utf8)))
    return mac.map { String(format: "%02x", $0) }.joined()
  }

  /// The four digits Groundwork shows next to this request in the map, worked out the same way from the secret.
  static func checkDigits(_ secret: String) -> String {
    let hash = SHA256.hash(data: Data("groundwork-pair:\(secret)".utf8)).map { String(format: "%02x", $0) }.joined()
    let n = UInt64(hash.prefix(8), radix: 16) ?? 0
    return String(format: "%04d", n % 10000)
  }

  static func sign(_ request: inout URLRequest) {
    if let current { request.setValue(current, forHTTPHeaderField: header) }
  }

  enum Asked { case allowed(code: String, digits: String), denied, noBrowser, unanswered }

  /// Ask the person at the Mac to allow this phone. Groundwork shows the
  /// request in the map with four digits, which `asking` gets too, to show
  /// here. Once allowed, the code comes back; it is kept only after the
  /// person confirms they allowed it next to those digits. Waits up to three minutes.
  static func ask(project: String, asking: (String) -> Void) async -> Asked {
    guard let server = await Locator.url() else { return .unanswered }
    // Known only to this phone: Groundwork tells the code to whoever holds it.
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
        guard let code = answer["code"] as? String else { return .unanswered }
        return .allowed(code: code, digits: digits)
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
