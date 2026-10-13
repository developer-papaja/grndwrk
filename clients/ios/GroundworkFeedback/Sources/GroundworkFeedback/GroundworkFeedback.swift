#if canImport(UIKit)
import UIKit

/// Comment on your running app, straight into the Groundwork map.
///
/// Call `GroundworkFeedback.start()` once, in a debug build. A small Comment
/// button floats over the app. Tap it, tap what you want to comment on, write
/// or say a line, and it lands in Groundwork on the Feedback page, with the
/// element, the screen and a picture of the spot.
///
///     #if DEBUG
///     import GroundworkFeedback
///     #endif
///
///     init() {
///       #if DEBUG
///       GroundworkFeedback.start()
///       #endif
///     }
@MainActor
public enum GroundworkFeedback {
  private static var overlay: OverlayWindow?
  static var controller: OverlayController? { overlay?.rootViewController as? OverlayController }

  /// Show the Groundwork button. Without `server`, it finds Groundwork by itself:
  /// on the same Wi-Fi when `groundwork --lan` runs, and in the Simulator also
  /// at localhost:7777. Comments written while Groundwork cannot be reached
  /// are kept on the device and sent once it can.
  ///
  /// It is a tool for your own debug builds. In an App Store build it never
  /// runs. In other builds that are not Debug (an Ad Hoc or TestFlight build
  /// for testers) it runs only with `allowOutsideDebug: true`; never submit
  /// such a build to the App Store.
  public static func start(server: URL? = nil, allowOutsideDebug: Bool = false) {
    guard Distribution.mayRun(allowOutsideDebug: allowOutsideDebug) else { return }
    Locator.fixed = server
    Connection.start()
    if attach() { return }
    // Before the first scene is active there is no window to float over yet.
    NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated { _ = attach() }
    }
  }

  static func didFlush(_ sent: Int) {
    controller?.updateBadge()
  }

  /// Open the list of comments: the ones waiting to be sent, and the ones sent.
  /// The same as a long press on the Groundwork button, then Show comments.
  public static func showComments() {
    controller?.showComments()
  }

  /// Send a picture of each screen the app shows to Groundwork, for its
  /// Sitemap view: once per screen per launch, while connected. On by default.
  public static var collectsScreenshots: Bool {
    get { Snapshots.enabled }
    set { Snapshots.enabled = newValue }
  }

  /// Opens a screen of the app by the name comments carry (its navigation
  /// title, `.groundworkScreen` name or view type). When set, a comment's page
  /// in the list has a Go to button, to test a fix where the comment was made.
  /// Return false when the name is not one the app can open.
  ///
  ///     GroundworkFeedback.openScreen = { name in
  ///       switch name {
  ///       case "Planner": router.show(.planner); return true
  ///       default: return false
  ///       }
  ///     }
  public static var openScreen: ((String) -> Bool)?

  /// Hide the Groundwork button until the next `start()`.
  public static func stop() {
    overlay?.isHidden = true
    overlay = nil
  }

  private static func attach() -> Bool {
    guard overlay == nil else { return true }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return false }
    let window = OverlayWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    window.rootViewController = OverlayController()
    window.isHidden = false
    overlay = window
    return true
  }
}

// MARK: - Self test

extension GroundworkFeedback {
  /// Send a comment on whatever sits at `point`, without tapping. For checking
  /// the setup from code or a launch argument: `-GroundworkSelfTest 200,400`.
  public static func comment(at point: CGPoint, text: String) {
    controller?.comment(at: point, text: text)
  }
}
#endif
