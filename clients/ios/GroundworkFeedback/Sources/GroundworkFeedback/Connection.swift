#if canImport(UIKit)
import UIKit

/// Whether Groundwork answers right now. Checked when the app comes to the
/// front, every 15 seconds while it is there, and after every comment sent.
/// The Comment button shows it as a dot, and the list of comments says it in words.
@MainActor
enum Connection {
  enum State: Equatable {
    /// Not checked yet.
    case unknown
    case connected(project: String, host: String)
    case offline
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
    guard let server = await Locator.url() else { return set(.offline) }
    var request = URLRequest(url: server.appendingPathComponent("api/hello"))
    request.timeoutInterval = 4
    do {
      let (body, response) = try await URLSession.shared.data(for: request)
      let hello = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
      guard (response as? HTTPURLResponse)?.statusCode == 200, hello?["groundwork"] as? Bool == true else {
        Locator.forget()
        return set(.offline)
      }
      set(.connected(project: hello?["project"] as? String ?? "", host: server.host ?? ""))
    } catch {
      Locator.forget()
      set(.offline)
    }
  }

  /// Sending a comment also tells whether Groundwork is there.
  static func reached(_ yes: Bool, project: String? = nil) {
    if yes, let server = Locator.current {
      set(.connected(project: project ?? self.project ?? "", host: server.host ?? ""))
    } else if !yes {
      set(.offline)
    }
  }

  private static func set(_ next: State) {
    let before = state
    state = next
    guard next != before else { return }
    NotificationCenter.default.post(name: changed, object: nil, userInfo: ["before": before])
    if case .connected = next {
      Task {
        await Outbox.flush()
        await Outbox.sync()
      }
    }
  }
}
#endif
