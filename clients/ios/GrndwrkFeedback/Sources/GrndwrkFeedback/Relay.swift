#if canImport(UIKit)
import CryptoKit
import UIKit

/// Sending comments through the team's relay, away from the Wi-Fi with
/// grndwrk. The person joins once with an invite (a link, or its QR code);
/// the phone makes a key of its own and leaves it at the relay sealed with
/// the invite's secret, for the team's grndwrk to let it in. From then on,
/// when no grndwrk answers on the Wi-Fi, comments go to the relay sealed and
/// signed, and the status of the sent ones comes back the same way.
///
/// The same keys, labels and lines as relay/src/crypto.ts and
/// src/relay/keys.ts: HMACs keyed by a key's hex text, AES-256-GCM with the
/// place bound in (`inbox:<device>`), nonce, ciphertext and tag in a row.
@MainActor
enum Relay {
  struct Joined: Codable, Equatable {
    var url: String
    var mailbox: String
    var key: String
    /// When the relay last refused this phone: not let in yet, or taken out.
    var refused: Date?
    /// When grndwrk made the last status read: an older one handed over again is ignored.
    var statusAt: Double?
    /// The four digits to tell whoever invited you; they allow this phone when the map shows the same.
    var digits: String { Relay.digits(key) }
  }

  enum Problem: Error { case notALink, unreachable, expired, used, refused(Int) }

  static let changed = Notification.Name("GrndwrkFeedback.relay")
  private static let storeKey = "GrndwrkFeedback.relay"

  /// In the Keychain, on this device only: never in a backup.
  static var joined: Joined? {
    get { keychain().flatMap { try? JSONDecoder().decode(Joined.self, from: $0) } }
    set {
      keychain(set: newValue.flatMap { try? JSONEncoder().encode($0) })
      NotificationCenter.default.post(name: changed, object: nil)
    }
  }

  private static func keychain() -> Data? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: storeKey, kSecAttrAccount as String: "relay", kSecReturnData as String: true]
    var out: AnyObject?
    return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }

  private static func keychain(set data: Data?) {
    let match: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: storeKey, kSecAttrAccount as String: "relay"]
    SecItemDelete(match as CFDictionary)
    guard let data else { return }
    var add = match
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }

  /// The same four digits grndwrk shows next to this phone in the map (`joinDigits` in src/relay/sync.ts).
  nonisolated static func digits(_ key: String) -> String {
    let hash = hex(SHA256.hash(data: Data("grndwrk-join:\(key)".utf8)))
    return String(format: "%04d", (UInt64(hash.prefix(8), radix: 16) ?? 0) % 10000)
  }

  /// Where comments go when the Wi-Fi has no grndwrk, in words for the list.
  static var status: String? {
    guard let j = joined else { return nil }
    let host = URL(string: j.url)?.host ?? j.url
    return j.refused == nil ? "Through the relay at \(host) when no grndwrk is on the Wi-Fi" : "Joined the relay at \(host). Waiting to be allowed: tell whoever invited you the digits \(j.digits)"
  }

  // MARK: Joining

  /// `grndwrk:invite/<relay host>/<mailbox>/<secret>`, as the map shows it. Not a web address, so a browser never takes it to the relay.
  /// The relay is reached over https; http only for localhost, to try it out.
  static func parse(_ link: String) -> (url: String, mailbox: String, secret: String)? {
    let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.hasPrefix("grndwrk:invite/") else { return nil }
    let parts = text.dropFirst("grndwrk:invite/".count).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[1].count == 32, parts[1].allSatisfy(isLowerHex), isKey(parts[2]) else { return nil }
    let host = parts[0]
    let hostPart = host.split(separator: ":", maxSplits: 1).map(String.init)
    guard let name = hostPart.first, !name.isEmpty, name.allSatisfy({ $0.isLetter && $0.isLowercase || $0.isNumber || $0 == "." || $0 == "-" }),
      name.allSatisfy(\.isASCII), hostPart.count == 1 || (hostPart[1].count <= 5 && hostPart[1].allSatisfy(\.isNumber)) else { return nil }
    let local = name == "localhost" || name == "127.0.0.1"
    return ("\(local ? "http" : "https")://\(host)", parts[1], parts[2])
  }

  /// Join with an invite: leave a new key, sealed with the invite's secret. The invite works once.
  static func join(_ link: String) async throws {
    guard let (url, mailbox, secret) = parse(link) else { throw Problem.notALink }
    let key = randomKey()
    let invite = String(hex(SHA256.hash(data: Data("grndwrk-invite:\(secret)".utf8))).prefix(32))
    let plain = try JSONSerialization.data(withJSONObject: ["key": key])
    var request = URLRequest(url: URL(string: "\(url)/v1/\(mailbox)/join/\(invite)")!)
    request.httpMethod = "POST"
    request.httpBody = try seal(plain, key: secret, context: "join:\(invite)")
    request.timeoutInterval = 15
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { throw Problem.unreachable }
    switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
    case 202: joined = Joined(url: url, mailbox: mailbox, key: key, refused: Date())
    case 404: throw Problem.expired
    case 409: throw Problem.used
    case let s: throw Problem.refused(s)
    }
  }

  static func leave() { joined = nil }

  // MARK: Sending

  enum Sent { case left, notLetIn, unreachable, refused }

  /// One request, as it would go to grndwrk on the Wi-Fi (`api/feedback`, `api/feedback/tested` ...), sealed and left at the relay.
  static func send(path: String, body: Data) async -> Sent {
    guard let j = joined, let object = try? JSONSerialization.jsonObject(with: body),
      // An id and the time, sealed with it: grndwrk refuses one the relay hands over again.
      let plain = try? JSONSerialization.data(withJSONObject: ["path": "/" + path, "body": object, "id": UUID().uuidString, "at": Int64(Date().timeIntervalSince1970 * 1000)]),
      let sealed = try? seal(plain, key: sealKey(j.key), context: "inbox:\(deviceId(j.key))") else { return .refused }
    let (status, _) = await call(j, "POST", "/inbox", body: sealed)
    return answer(status, ok: 202)
  }

  /// What became of the comments sent through the relay: grndwrk's status of each, by key. Nil when there is nothing new or no answer.
  static func statuses() async -> [[String: Any]]? {
    guard let j = joined else { return nil }
    let (status, data) = await call(j, "GET", "/outbox")
    guard answer(status, ok: 200) == .left, let data,
      let plain = open(data, key: sealKey(j.key), context: "outbox:\(deviceId(j.key))"),
      let answer = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any],
      let list = answer["comments"] as? [[String: Any]] else { return nil }
    // An older status than the last one read, handed over again by the relay: ignored.
    let at = (answer["at"] as? NSNumber)?.doubleValue ?? 0
    if var now = joined {
      if let last = now.statusAt, at <= last { return nil }
      now.statusAt = at
      joined = now
    }
    return list
  }

  /// 401: the team's grndwrk has not let this phone in yet, or took it out. Kept until it answers again.
  private static func answer(_ status: Int, ok: Int) -> Sent {
    guard var j = joined else { return .refused }
    if status == ok || (ok == 200 && status == 204) {
      if j.refused != nil {
        j.refused = nil
        joined = j
      }
      return status == 204 ? .unreachable : .left
    }
    if status == 401 {
      if j.refused == nil {
        j.refused = Date()
        joined = j
      }
      return .notLetIn
    }
    return status == 0 || status == 429 || status >= 500 ? .unreachable : .refused
  }

  private static func call(_ j: Joined, _ method: String, _ rest: String, body: Data? = nil) async -> (Int, Data?) {
    guard let url = URL(string: "\(j.url)/v1/\(j.mailbox)\(rest)") else { return (0, nil) }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.timeoutInterval = 30
    let signKey = signKey(j.key)
    let time = String(Int64(Date().timeIntervalSince1970 * 1000))
    let nonce = UUID().uuidString + UUID().uuidString.prefix(8)
    let line = "grndwrk-request\n\(method)\n\(url.path)\n\(time)\n\(nonce)\n\(hex(SHA256.hash(data: body ?? Data())))"
    request.setValue(deviceId(j.key), forHTTPHeaderField: "X-Grndwrk-Device")
    request.setValue(time, forHTTPHeaderField: "X-Grndwrk-Time")
    request.setValue(nonce, forHTTPHeaderField: "X-Grndwrk-Nonce")
    request.setValue(hmac(signKey, line), forHTTPHeaderField: "X-Grndwrk-Signature")
    guard let (data, response) = try? await URLSession.shared.data(for: request) else { return (0, nil) }
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
  }

  // MARK: Keys and sealing

  static func signKey(_ key: String) -> String { hmac(key, "grndwrk-relay:sign") }
  static func sealKey(_ key: String) -> String { hmac(key, "grndwrk-relay:seal") }
  /// The phone's id at the relay, from its signing key.
  static func deviceId(_ key: String) -> String {
    String(hex(SHA256.hash(data: Data("grndwrk-device:\(signKey(key))".utf8))).prefix(32))
  }

  static func hmac(_ key: String, _ message: String) -> String {
    hex(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: Data(key.utf8))))
  }

  static func seal(_ plain: Data, key: String, context: String) throws -> Data {
    guard let raw = bytes(key), raw.count == 32 else { throw Problem.notALink }
    let box = try AES.GCM.seal(plain, using: SymmetricKey(data: raw), nonce: AES.GCM.Nonce(), authenticating: Data(context.utf8))
    guard let combined = box.combined else { throw Problem.notALink }
    return combined
  }

  static func open(_ sealed: Data, key: String, context: String) -> Data? {
    guard let raw = bytes(key), raw.count == 32, let box = try? AES.GCM.SealedBox(combined: sealed) else { return nil }
    return try? AES.GCM.open(box, using: SymmetricKey(data: raw), authenticating: Data(context.utf8))
  }

  private static func randomKey() -> String {
    var raw = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, raw.count, &raw)
    return hex(raw)
  }

  private static func isLowerHex(_ c: Character) -> Bool { c.isHexDigit && !c.isUppercase }
  private static func isKey(_ s: String) -> Bool { s.count == 64 && s.allSatisfy(isLowerHex) }

  private static func bytes(_ hex: String) -> Data? {
    guard hex.count % 2 == 0 else { return nil }
    var out = Data(capacity: hex.count / 2)
    var i = hex.startIndex
    while i < hex.endIndex {
      let j = hex.index(i, offsetBy: 2)
      guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }
      out.append(b)
      i = j
    }
    return out
  }

  nonisolated private static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
    bytes.map { String(format: "%02x", $0) }.joined()
  }
}
#endif
