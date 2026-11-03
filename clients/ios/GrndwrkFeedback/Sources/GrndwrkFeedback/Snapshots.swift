#if canImport(UIKit)
import UIKit

/// Pictures of the screens the app shows, for the Sitemap view in grndwrk.
/// While connected, each screen is taken once per launch, after it has stayed
/// in view for a moment, so walking through the app once collects them all.
/// The grndwrk button and anything it shows are in their own window and never
/// in the picture. Turn it off with `GrndwrkFeedback.collectsScreenshots = false`.
@MainActor
enum Snapshots {
  static var enabled = true
  /// What was sent this launch, per name: one entry per screen that looked different.
  private static var taken: [String: [Set<String>]] = [:]
  private static var last: (key: String, look: Set<String>)?
  private static var sending = false
  private static var woke = false
  /// An older grndwrk without screenshots: stop asking until the next launch.
  private static var unsupported = false
  /// When a picture of each screen went to grndwrk this launch, by name.
  private static var sentAt: [String: Date] = [:]
  /// A picture went to grndwrk. userInfo["screen"]: the name it was sent under.
  static let tookPicture = Notification.Name("GrndwrkFeedback.tookPicture")

  /// Whether this screen has a picture yet, in words, for the long-press menu.
  static func status(window: UIWindow?) -> String {
    guard enabled else { return "Pictures of screens are turned off in this app." }
    guard let window else { return "" }
    let screen = Inspector.screen(of: window)
    let key = screen.component ?? screen.name
    guard let at = sentAt[key] else { return "No picture of \u{201C}\(screen.name)\u{201D} yet. Stay on it a second, or take one now." }
    return "Picture of \u{201C}\(screen.name)\u{201D} taken \(at.formatted(date: .omitted, time: .shortened))."
  }

  /// Take a picture of the screen now, as it is: for when the automatic one
  /// showed something else, or none was taken. Replaces the one before.
  static func takeNow(window: UIWindow?) {
    guard enabled, case .connected = Connection.state, let window, let server = Locator.current else { return }
    let screen = Inspector.screen(of: window)
    let contents = Inspector.contents(of: window)
    send(window: window, screen: screen, contents: contents, look: look(contents), server: server)
  }

  /// Called every second with the app's window. `busy` while the
  /// person is picking an element or writing a comment.
  static func tick(window: UIWindow?, busy: Bool) {
    guard enabled, !unsupported, !sending, !busy, case .connected = Connection.state, let window, let server = Locator.current else {
      last = nil
      return
    }
    let screen = Inspector.screen(of: window)
    let key = screen.component ?? screen.name
    var contents = Inspector.contents(of: window)
    // On a device iOS builds the accessibility tree only when asked.
    if contents.texts.isEmpty, contents.ids.isEmpty, !woke {
      woke = true
      if Inspector.wakeAccessibility() { return }
    }
    let look = Snapshots.look(contents)
    let before = last
    last = (key, look)
    // Only once it has stayed the same for a tick: not halfway through a transition.
    guard let before, before.key == key, Snapshots.alike(before.look, look) else { return }
    // A screen with its own name is taken once. One without, like App, once
    // for each screen that looks different, since several share the name.
    let sent = taken[key] ?? []
    if screen.named ? !sent.isEmpty : sent.contains(where: { Snapshots.alike($0, look) }) { return }
    send(window: window, screen: screen, contents: contents, look: look, server: server)
  }

  private static func send(window: UIWindow, screen: Inspector.Screen, contents: (texts: [String], ids: [String]), look: Set<String>, server: URL) {
    guard !sending else { return }
    var contents = contents
    let key = screen.component ?? screen.name
    let format = UIGraphicsImageRendererFormat()
    format.scale = min(2, window.screen.scale)
    let fields = Inspector.textFields(in: window)
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
      Inspector.blank(fields)
    }
    guard let jpeg = image.jpegData(compressionQuality: 0.6) else { return }
    contents.texts = Array(contents.texts.prefix(60))
    var body: [String: Any] = [
      "platform": "iOS", "screen": screen.name, "named": screen.named,
      "texts": contents.texts, "ids": contents.ids,
      "image": "data:image/jpeg;base64," + jpeg.base64EncodedString(),
    ]
    if let component = screen.component { body["component"] = component }
    guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }

    sending = true
    Task {
      defer { sending = false }
      var request = URLRequest(url: server.appendingPathComponent("api/screenshot"))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = data
      request.timeoutInterval = 15
      Pairing.sign(&request)
      let status = ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
      switch status {
      case 200, 201:
        taken[key, default: []].append(look)
        sentAt[key] = Date()
        NotificationCenter.default.post(name: tookPicture, object: nil, userInfo: ["screen": screen.name])
        gwLog.info("Sent a picture of \(key, privacy: .public)")
      case 404:
        unsupported = true
        gwLog.info("This grndwrk does not take pictures of screens yet")
      default:
        gwLog.error("A picture of \(key, privacy: .public) was not taken (\(status))")
      }
    }
  }

  /// The texts and identifiers, without digits, so a clock or a count does
  /// not make the same screen look new.
  static func look(_ contents: (texts: [String], ids: [String])) -> Set<String> {
    Set((contents.texts + contents.ids).map { $0.lowercased().replacingOccurrences(of: "[0-9]+", with: "#", options: .regularExpression) })
  }

  /// The same screen: at least half of what either shows is shared. Nothing
  /// to compare counts as the same.
  static func alike(_ a: Set<String>, _ b: Set<String>) -> Bool {
    if a.isEmpty || b.isEmpty { return true }
    return Double(a.intersection(b).count) / Double(a.union(b).count) >= 0.5
  }
}
#endif
