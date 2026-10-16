#if canImport(UIKit)
import UIKit

/// Comments on the device: the ones waiting to be sent, one JSON file each in
/// Application Support, sent in the order they were written once grndwrk
/// answers; and the ones sent, kept in sent.json so the person can look back,
/// delete them, and see what became of them in grndwrk.
///
/// Every comment carries a random key. grndwrk keeps it, and only a device
/// that holds the key can ask about the comment or delete it.
@MainActor
enum Outbox {
  enum Result { case sent(id: String, project: String?), rejected(Int), blockedByATS, unreachable, needsCode }

  /// A comment as the list shows it.
  struct Item {
    var file: URL?
    /// The node id in grndwrk, for sent comments.
    var node: String?
    var text: String
    var detail: String
    var written: Date?
    /// incoming, proposed or fixed, as grndwrk last said.
    var state: String?
    /// What Claude wrote about the fix it proposed or made.
    var fix: String?
    /// The screen it was made on, as the app named it.
    var screen: String?
    /// How to test the fix, as Claude wrote it after "To test:".
    var test: String?
  }

  static let changed = Notification.Name("GrndwrkFeedback.outbox")
  /// Claude proposed fixes for comments sent from here, since the last look. userInfo["count"]: how many to test now.
  static let newFixes = Notification.Name("GrndwrkFeedback.newFixes")
  private static var flushing = false
  private static var base: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("GrndwrkFeedback", isDirectory: true)
  }
  private static var dir: URL { base.appendingPathComponent("outbox", isDirectory: true) }
  private static var files: [URL] {
    let list = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
    return list.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  }
  static var count: Int { files.count }

  /// A new comment, ready to send.
  static func comment(text: String, found: Inspector.Found, screen: Inspector.Screen, image: Data?, onMac: Bool = false) -> Data? {
    var element: [String: String] = ["role": found.role]
    if let v = found.label { element["label"] = v }
    if let v = found.identifier { element["id"] = v }
    if let v = screen.component { element["component"] = v }
    var body: [String: Any] = [
      "text": text, "platform": "iOS", "screen": screen.name, "element": element,
      "written": ISO8601DateFormatter().string(from: Date()), "key": UUID().uuidString,
    ]
    if onMac { body["on_mac"] = true }
    if let image { body["image"] = "data:image/png;base64," + image.base64EncodedString() }
    return try? JSONSerialization.data(withJSONObject: body)
  }

  static func save(_ data: Data) {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let name = String(format: "%.0f", Date().timeIntervalSince1970 * 1000) + "-" + UUID().uuidString.prefix(6) + ".json"
    try? data.write(to: dir.appendingPathComponent(name))
    NotificationCenter.default.post(name: changed, object: nil)
  }

  static func post(_ data: Data, to path: String = "api/feedback") async -> Result {
    guard let server = await Locator.url() else {
      Connection.reached(false, why: Locator.problem)
      return .unreachable
    }
    var request = URLRequest(url: server.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = data
    request.timeoutInterval = 10
    Pairing.sign(&request)
    do {
      let (body, response) = try await URLSession.shared.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let answer = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
      // Without the pairing code nothing is lost: it waits until the code is entered.
      if status == 401 {
        Connection.codeRefused()
        return .needsCode
      }
      // Too many at once: keep it and try again later.
      if status == 429 { return .unreachable }
      if status == 200 || status == 201 {
        Connection.reached(true, project: answer?["project"] as? String)
        return .sent(id: answer?["id"] as? String ?? "", project: answer?["project"] as? String)
      }
      // An old grndwrk without comments, or a server error: keep it for later.
      if status == 404 || status >= 500 {
        gwLog.error("Sending to \(server.absoluteString, privacy: .public) got \(status)")
        Locator.forget()
        Connection.reached(false, why: "grndwrk at \(server.host ?? "") answered \(status) to a comment.")
        return .unreachable
      }
      return .rejected(status)
    } catch let error as URLError where error.code == .appTransportSecurityRequiresSecureConnection {
      return .blockedByATS
    } catch {
      // grndwrk may have moved, or stopped: look for it again next time.
      gwLog.error("Sending to \(server.absoluteString, privacy: .public) failed: \(Connection.words(error), privacy: .public)")
      Locator.forget()
      Connection.reached(false, why: "Sending to \(server.host ?? "") failed: \(Connection.words(error)).")
      return .unreachable
    }
  }

  // MARK: Sent

  private static var sentFile: URL { base.appendingPathComponent("sent.json") }
  private static var deletesFile: URL { base.appendingPathComponent("deletes.json") }

  private static func read(_ file: URL) -> [[String: Any]] {
    ((try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
  }

  private static func write(_ list: [[String: Any]], to file: URL) {
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    if let out = try? JSONSerialization.data(withJSONObject: list) { try? out.write(to: file) }
    NotificationCenter.default.post(name: changed, object: nil)
  }

  /// Keep a sent comment, without its picture. The last 200.
  private static var pictures: URL { base.appendingPathComponent("pictures", isDirectory: true) }

  /// The picture taken with a sent comment, to show when testing its fix.
  static func picture(node: String) -> UIImage? {
    UIImage(contentsOfFile: pictures.appendingPathComponent("\(node).png").path)
  }

  /// The picture of a waiting comment, from the comment itself.
  static func picture(file: URL) -> UIImage? {
    guard let data = try? Data(contentsOf: file), let c = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let image = c["image"] as? String, let comma = image.firstIndex(of: ","), let bytes = Data(base64Encoded: String(image[image.index(after: comma)...])) else { return nil }
    return UIImage(data: bytes)
  }

  static func remember(_ data: Data, id: String, project: String?) {
    guard var entry = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    // The picture stays on the phone, beside the list, to show when testing a fix.
    if let image = entry["image"] as? String, let comma = image.firstIndex(of: ","), let bytes = Data(base64Encoded: String(image[image.index(after: comma)...])), !id.isEmpty {
      try? FileManager.default.createDirectory(at: pictures, withIntermediateDirectories: true)
      try? bytes.write(to: pictures.appendingPathComponent("\(id).png"))
    }
    entry["image"] = nil
    entry["node"] = id
    entry["project"] = project ?? Connection.project
    entry["sent"] = ISO8601DateFormatter().string(from: Date())
    let kept = Array((read(sentFile) + [entry]).suffix(200))
    write(kept, to: sentFile)
    // Pictures of comments that fell off the list go too.
    let ids = Set(kept.compactMap { $0["node"] as? String })
    for file in (try? FileManager.default.contentsOfDirectory(at: pictures, includingPropertiesForKeys: nil)) ?? [] where !ids.contains(file.deletingPathExtension().lastPathComponent) {
      try? FileManager.default.removeItem(at: file)
    }
  }

  static var waiting: [Item] {
    files.compactMap { file in
      (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }.map { item(from: $0, file: file) }
    }
  }

  static var sent: [Item] { read(sentFile).reversed().map { item(from: $0, file: nil) } }

  private static func item(from c: [String: Any], file: URL?) -> Item {
    let element = c["element"] as? [String: Any]
    let on = [element?["role"] as? String, (element?["label"] as? String).map { "\u{201C}\($0.prefix(40))\u{201D}" }].compactMap { $0 }.joined(separator: " ")
    var parts = [c["screen"] as? String, on.isEmpty ? nil : on].compactMap { $0 }
    if let status = c["status"] as? String, status != "open" { parts.append(status) }
    let node = c["node"] as? String
    if let node, !node.isEmpty { parts.append(node) }
    let written = (c["written"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
    // What it is called in grndwrk now, when the person edited it there.
    var text = c["title"] as? String ?? c["text"] as? String ?? ""
    if text.isEmpty, c["on_mac"] as? Bool == true { text = "Written on the Mac" }
    return Item(file: file, node: node, text: text, detail: parts.joined(separator: " · "), written: written, state: c["state"] as? String, fix: c["fix"] as? String, screen: c["screen"] as? String, test: c["test"] as? String)
  }

  /// Ask grndwrk what became of the sent comments: their title and status
  /// now. Comments deleted there are dropped here too. Only comments sent to
  /// the project that answers are asked about.
  static func sync() async {
    guard let project = Connection.project else { return }
    let list = read(sentFile)
    let ask = list.compactMap { c -> [String: String]? in
      guard let id = c["node"] as? String, let key = c["key"] as? String, !id.isEmpty, (c["project"] as? String ?? project) == project else { return nil }
      return ["id": id, "key": key]
    }
    guard !ask.isEmpty, let data = try? JSONSerialization.data(withJSONObject: ["comments": ask]),
      let server = await Locator.url() else { return }
    var request = URLRequest(url: server.appendingPathComponent("api/feedback/status"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = data
    request.timeoutInterval = 10
    Pairing.sign(&request)
    guard let (body, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
      let answer = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["comments"] as? [[String: Any]] else { return }
    let now = Dictionary(answer.compactMap { a in (a["id"] as? String).map { ($0, a) } }, uniquingKeysWith: { a, _ in a })
    let before = Set(read(sentFile).filter { $0["state"] as? String == "ready" }.compactMap { $0["node"] as? String })
    // Read again: something may have changed while asking.
    var next: [[String: Any]] = []
    for var c in read(sentFile) {
      guard let id = c["node"] as? String, let a = now[id] else {
        next.append(c)
        continue
      }
      if a["gone"] as? Bool == true { continue }
      c["title"] = a["title"]
      c["status"] = a["status"]
      c["state"] = a["state"]
      c["fix"] = a["fix"]
      c["test"] = a["test"]
      next.append(c)
    }
    write(next, to: sentFile)
    let ready = next.filter { $0["state"] as? String == "ready" }.compactMap { $0["node"] as? String }
    if !Set(ready).subtracting(before).isEmpty {
      NotificationCenter.default.post(name: newFixes, object: nil, userInfo: ["count": ready.count])
    }
  }

  /// Sent comments whose fix is built: the ones to test in the app. A fix only proposed is not tested.
  static var toTest: [Item] { sent.filter { $0.state == "ready" } }

  /// The person tested a fix here: it works (fixed), or not yet (back to
  /// grndwrk with a note). Needs grndwrk to answer; true when it did.
  static func tested(node: String, works: Bool, note: String = "") async -> Bool {
    guard let entry = read(sentFile).first(where: { $0["node"] as? String == node }), let key = entry["key"] as? String else { return false }
    var body: [String: Any] = ["comments": [["id": node, "key": key]], "works": works]
    if !note.isEmpty { body["note"] = note }
    guard let data = try? JSONSerialization.data(withJSONObject: body), case .sent = await post(data, to: "api/feedback/tested") else { return false }
    await sync()
    NotificationCenter.default.post(name: changed, object: nil)
    return true
  }

  /// Open the comment in grndwrk on the Mac: in the map when it is open, else in a new tab. True when grndwrk took it.
  static func showOnMac(node: String) async -> Bool {
    guard let entry = read(sentFile).first(where: { $0["node"] as? String == node }), let key = entry["key"] as? String,
      let data = try? JSONSerialization.data(withJSONObject: ["comments": [["id": node, "key": key]]]) else { return false }
    if case .sent = await post(data, to: "api/feedback/show") { return true }
    return false
  }

  enum Deleted { case everywhere, later, onlyHere }

  /// Delete a sent comment here and in grndwrk. When grndwrk is not
  /// reachable, it is deleted there once it is.
  static func deleteSent(node: String) async -> Deleted {
    let list = read(sentFile)
    guard let entry = list.first(where: { $0["node"] as? String == node }) else { return .onlyHere }
    write(list.filter { $0["node"] as? String != node }, to: sentFile)
    try? FileManager.default.removeItem(at: pictures.appendingPathComponent("\(node).png"))
    // Sent before comments had keys: grndwrk would not know it is ours.
    guard let key = entry["key"] as? String else { return .onlyHere }
    var deletes = read(deletesFile)
    deletes.append(["id": node, "key": key, "project": entry["project"] as? String ?? ""])
    write(deletes, to: deletesFile)
    return await flushDeletes() ? .everywhere : .later
  }

  /// Send the deletes that wait. True when none are left.
  @discardableResult
  private static func flushDeletes() async -> Bool {
    let deletes = read(deletesFile)
    guard !deletes.isEmpty else { return true }
    guard let project = Connection.project else { return false }
    let mine = deletes.filter { ($0["project"] as? String ?? "").isEmpty || $0["project"] as? String == project }
    guard !mine.isEmpty, let data = try? JSONSerialization.data(withJSONObject: ["comments": mine]) else { return false }
    guard case .sent = await post(data, to: "api/feedback/remove") else { return false }
    let done = Set(mine.compactMap { $0["id"] as? String })
    let left = read(deletesFile).filter { !done.contains($0["id"] as? String ?? "") }
    write(left, to: deletesFile)
    return left.isEmpty
  }

  // MARK: Waiting

  /// Every waiting comment in one file: { "grndwrk": "feedback", "comments": [...] }.
  static func export() -> (URL, [URL])? {
    let list = files
    let comments = list.compactMap { (try? Data(contentsOf: $0)).flatMap { try? JSONSerialization.jsonObject(with: $0) } }
    guard !comments.isEmpty, let data = try? JSONSerialization.data(withJSONObject: ["grndwrk": "feedback", "comments": comments]) else { return nil }
    let stamp = ISO8601DateFormatter().string(from: Date()).prefix(16).replacingOccurrences(of: ":", with: "")
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("grndwrk-feedback-\(stamp).json")
    guard (try? data.write(to: url)) != nil else { return nil }
    return (url, list)
  }

  static func remove(_ list: [URL]) {
    for file in list { try? FileManager.default.removeItem(at: file) }
    NotificationCenter.default.post(name: changed, object: nil)
  }

  /// Send what waits, oldest first. Stops at the first one that cannot go yet.
  static func flush() async {
    guard !flushing else { return }
    flushing = true
    defer { flushing = false }
    var sent = 0
    for file in files {
      guard let data = try? Data(contentsOf: file) else { continue }
      switch await post(data) {
      case .sent(let id, let project):
        remember(data, id: id, project: project)
        try? FileManager.default.removeItem(at: file)
        sent += 1
      case .rejected:
        // Sent, or refused for good: either way it should not be tried again.
        try? FileManager.default.removeItem(at: file)
        sent += 1
      case .unreachable, .blockedByATS, .needsCode:
        return
      }
    }
    await flushDeletes()
    if sent > 0 {
      NotificationCenter.default.post(name: changed, object: nil)
      GrndwrkFeedback.didFlush(sent)
    }
  }
}
#endif
