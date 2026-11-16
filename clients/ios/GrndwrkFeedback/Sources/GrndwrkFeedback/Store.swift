#if canImport(UIKit)
import UIKit

/// Sending comments straight to the team's store, away from the Wi-Fi with
/// grndwrk (docs/store-protocol.md, Comments straight to the store). The
/// person joins once with a store link from the team's store (its login, or
/// a link someone sent): `grndwrk:store/<host><path>#<comment token>`. The
/// token may only leave comments in this phone's own inbox folder and read
/// its own status file, never the map. When no grndwrk answers on the Wi-Fi,
/// comments go into the store's inbox, where any teammate's grndwrk files
/// them; test results and deletes go the same way, as envelopes like the
/// relay's, and the status of what was sent comes back from the status file.
///
/// A phone joined to both a store and a relay uses the store.
@MainActor
enum Store {
  struct Joined: Codable, Equatable {
    /// The project's address at the store, ending in /.
    var url: String
    var token: String
    /// The id the store gave this phone: its comments go in `inbox/<commenter>/`, its status is `status/<commenter>.json`.
    var commenter: String
    /// When the store last refused the token: logged out, or taken back.
    var refused: Date?
  }

  enum Problem: Error { case notALink, unreachable, refused, mayDoMore, noCommenter }

  static let changed = Notification.Name("GrndwrkFeedback.store")
  private static let service = "GrndwrkFeedback.store"

  /// In the Keychain, on this device only: never in a backup.
  static var joined: Joined? {
    get { keychain().flatMap { try? JSONDecoder().decode(Joined.self, from: $0) } }
    set {
      keychain(set: newValue.flatMap { try? JSONEncoder().encode($0) })
      NotificationCenter.default.post(name: changed, object: nil)
      // The relay's listeners redraw too: the menu and the list say where comments go.
      NotificationCenter.default.post(name: Relay.changed, object: nil)
    }
  }

  private static func keychain() -> Data? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "store", kSecReturnData as String: true]
    var out: AnyObject?
    return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }

  private static func keychain(set data: Data?) {
    let match: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "store"]
    SecItemDelete(match as CFDictionary)
    guard let data else { return }
    var add = match
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }

  static var host: String { joined.flatMap { URL(string: $0.url)?.host } ?? "" }

  /// Where comments go when the Wi-Fi has no grndwrk, in words for the list.
  static var status: String? {
    guard let j = joined else { return nil }
    return j.refused == nil ? "Straight to your team's store at \(host) when no grndwrk is on the Wi-Fi" : "Joined your team's store at \(host), but it no longer takes this phone's link. Join again with a new store link"
  }

  // MARK: Joining

  private static func isCommenter(_ s: String) -> Bool {
    (8...64).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
  }

  /// `grndwrk:store/<host><path>#<token>`. Not a web address, so a browser never takes the token anywhere.
  /// The store is reached over https; http only for localhost, to try it out.
  static func parse(_ link: String) -> (url: String, token: String)? {
    let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.hasPrefix("grndwrk:store/"), let hash = text.firstIndex(of: "#") else { return nil }
    let place = String(text[text.index(text.startIndex, offsetBy: "grndwrk:store/".count)..<hash])
    let token = String(text[text.index(after: hash)...])
    let tokenChars = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-")
    guard (8...4096).contains(token.count), token.allSatisfy({ tokenChars.contains($0) }) else { return nil }
    let slash = place.firstIndex(of: "/") ?? place.endIndex
    let host = String(place[..<slash])
    var path = String(place[slash...])
    let hostPart = host.split(separator: ":", maxSplits: 1).map(String.init)
    guard let name = hostPart.first, !name.isEmpty, name.allSatisfy({ $0.isASCII && ($0.isLetter && $0.isLowercase || $0.isNumber || $0 == "." || $0 == "-") }),
      hostPart.count == 1 || (hostPart[1].count <= 5 && hostPart[1].allSatisfy(\.isNumber)),
      path.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "._~%/-".contains($0)) }), !path.contains("..") else { return nil }
    if !path.hasSuffix("/") { path += "/" }
    let local = name == "localhost" || name == "127.0.0.1"
    return ("\(local ? "http" : "https")://\(host)\(path)", token)
  }

  /// Join with a store link: the store says this token may only leave comments, and who this phone is.
  static func join(_ link: String) async throws {
    guard let (url, token) = parse(link) else { throw Problem.notALink }
    let (status, data) = await call(url, token, "GET", "hello")
    if status == 0 { throw Problem.unreachable }
    if status == 401 || status == 403 { throw Problem.refused }
    guard status == 200, let hello = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] else { throw Problem.unreachable }
    // A token that may read or change the map does not belong on a phone that only comments.
    guard hello["role"] as? String == "comment" else { throw Problem.mayDoMore }
    guard let commenter = hello["commenter"] as? String, isCommenter(commenter) else { throw Problem.noCommenter }
    joined = Joined(url: url, token: token, commenter: commenter)
    reachable = true
  }

  static func leave() { joined = nil }

  /// Whether the store answered the last time it was asked.
  private(set) static var reachable = true {
    didSet { if reachable != oldValue { NotificationCenter.default.post(name: changed, object: nil) } }
  }

  /// Joined, the link still taken, and the store answers: comments go there.
  static var usable: Bool { joined != nil && joined?.refused == nil && reachable }

  /// Asks the store whether it still takes this phone's link, so a refused one shows as soon as it is.
  static func check() async {
    guard let j = joined else { return }
    let (status, _) = await call(j.url, j.token, "GET", "hello")
    _ = answer(status, ok: [200])
  }

  // MARK: Sending

  /// One request, as it would go to grndwrk on the Wi-Fi: a comment as a file of its own in the inbox,
  /// a test result or a delete as an envelope `{ path, body, at }`. Show on my Mac does not go through a store.
  static func send(path: String, body: Data) async -> Relay.Sent {
    guard let j = joined, var object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return .refused }
    let file: String
    let bytes: Data?
    switch path {
    case "api/feedback":
      // Written on the Mac is for grndwrk on the Wi-Fi: here nobody's map is asked to open.
      guard object["on_mac"] == nil else { return .refused }
      // Named after its key, so a try that got no answer and is sent again is the same file.
      let key = object["key"] as? String ?? UUID().uuidString
      object["key"] = key
      file = "c_\(key)"
      bytes = try? JSONSerialization.data(withJSONObject: object)
    case "api/feedback/tested", "api/feedback/remove":
      object["on_mac"] = nil
      file = "r_\(UUID().uuidString)"
      bytes = try? JSONSerialization.data(withJSONObject: ["path": "/" + path, "body": object, "at": Int64(Date().timeIntervalSince1970 * 1000)])
    default:
      return .refused
    }
    guard let bytes, isCommenter(file) else { return .refused }
    let (status, _) = await call(j.url, j.token, "PUT", "files/inbox/\(j.commenter)/\(file).json", body: bytes, create: true)
    // 412: there already, from a try that got no answer.
    return answer(status, ok: [200, 201, 412])
  }

  /// What became of the comments sent to the store: grndwrk's status of each, by key. Nil when there is no answer.
  static func statuses() async -> [[String: Any]]? {
    guard let j = joined else { return nil }
    let (status, data) = await call(j.url, j.token, "GET", "files/status/\(j.commenter).json")
    // Nothing filed yet.
    if status == 404 { return [] }
    guard answer(status, ok: [200]) == .left, let data,
      let list = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["comments"] as? [[String: Any]] else { return nil }
    return list
  }

  /// 401 or 403: the store no longer takes the link. Kept until it does again, or the person joins with a new one.
  private static func answer(_ status: Int, ok: [Int]) -> Relay.Sent {
    guard var j = joined else { return .refused }
    reachable = !(status == 0 || status == 429 || status >= 500)
    if ok.contains(status) {
      if j.refused != nil {
        j.refused = nil
        joined = j
      }
      return .left
    }
    if status == 401 || status == 403 {
      if j.refused == nil {
        j.refused = Date()
        joined = j
      }
      return .notLetIn
    }
    // Refused for good only when the store says what is wrong with it; anything else, it waits on the phone.
    return [400, 413, 415].contains(status) ? .refused : .unreachable
  }

  private static func call(_ base: String, _ token: String, _ method: String, _ rest: String, body: Data? = nil, create: Bool = false) async -> (Int, Data?) {
    guard let url = URL(string: "\(base)v1/\(rest)") else { return (0, nil) }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.timeoutInterval = 30
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if create { request.setValue("*", forHTTPHeaderField: "If-None-Match") }
    // The token goes only to the store's own address, never after a redirect.
    guard let (data, response) = try? await URLSession.shared.data(for: request, delegate: NoRedirects.shared) else { return (0, nil) }
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
  }
}

/// Never follows a redirect: the token is sent to the store's own address only.
final class NoRedirects: NSObject, URLSessionTaskDelegate {
  static let shared = NoRedirects()
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
#endif
