#if canImport(UIKit)
import UIKit

/// The injected start, called by the loader's constructor before the app's
/// own code runs. Waits for the first scene to be active, then starts the
/// Comment button, unless the app already runs GroundworkFeedback itself.
@_cdecl("GroundworkFeedbackInject")
public func groundworkFeedbackInject() {
  Injected.observer = NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { _ in
    if let observer = Injected.observer { NotificationCenter.default.removeObserver(observer) }
    Injected.observer = nil
    // One turn later, so an app that starts GroundworkFeedback itself as its scene appears has done so.
    DispatchQueue.main.async {
      MainActor.assumeIsolated { Injected.start() }
    }
  }
}

enum Injected {
  nonisolated(unsafe) static var observer: NSObjectProtocol?

  @MainActor
  static func start() {
    if appRunsItsOwn() {
      gwLog.info("Injected, but the app runs GroundworkFeedback itself: not starting a second button")
      return
    }
    // GROUNDWORK_SERVER: Groundwork somewhere else than localhost:7777, like http://localhost:7790.
    let server = ProcessInfo.processInfo.environment["GROUNDWORK_SERVER"].flatMap(URL.init(string:))
    gwLog.info("Injected: starting the Comment button\(server.map { " for \($0.absoluteString)" } ?? "", privacy: .public)")
    GroundworkFeedback.start(server: server)
  }

  /// The app's own copy of the package shows its button in a window of this
  /// class. Two copies of a class share the name, so look by name.
  @MainActor
  private static func appRunsItsOwn() -> Bool {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .contains { NSStringFromClass(type(of: $0)) == "GroundworkFeedback.OverlayWindow" }
  }
}
#endif
