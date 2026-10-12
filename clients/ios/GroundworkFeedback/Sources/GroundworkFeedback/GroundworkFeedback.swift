#if canImport(UIKit)
import Network
import UIKit

/// Comment on your running app, straight into the Groundwork map.
///
/// Call `GroundworkFeedback.start()` once, in a debug build. A small Comment
/// button floats over the app. Tap it, tap what you want to comment on, write
/// a line, and it lands in Groundwork on the Feedback page, with the element,
/// the screen and a picture of the spot.
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

  /// Show the Comment button. Without `server`, it finds Groundwork by itself:
  /// on the same Wi-Fi when `groundwork --lan` runs, and in the Simulator also
  /// at localhost:7777. Comments written while Groundwork cannot be reached
  /// are kept on the device and sent once it can.
  public static func start(server: URL? = nil) {
    Locator.fixed = server
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
      Task { await Outbox.flush() }
    }
    Task { await Outbox.flush() }
    if attach() { return }
    // Before the first scene is active there is no window to float over yet.
    NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated { _ = attach() }
    }
  }

  static func didFlush(_ sent: Int) {
    (overlay?.rootViewController as? OverlayController)?.updateBadge()
  }

  /// Open the list of comments: the ones waiting to be sent, and the ones sent.
  /// The same as a long press on the Comment button, then Show comments.
  public static func showComments() {
    (overlay?.rootViewController as? OverlayController)?.showComments()
  }

  /// Hide the Comment button until the next `start()`.
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

// MARK: - Overlay

/// Lets touches through to the app except on the Comment button, or everywhere while picking.
final class OverlayWindow: UIWindow {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard let hit = super.hitTest(point, with: event) else { return nil }
    if let controller = rootViewController as? OverlayController, controller.picking || controller.presentedViewController != nil { return hit }
    return hit === rootViewController?.view ? nil : hit
  }
}

@MainActor
final class OverlayController: UIViewController {
  private let button = UIButton(type: .system)
  private let hint = PaddedLabel()
  private let highlight = UIView()
  private let toast = PaddedLabel()
  private(set) var picking = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear

    var config = UIButton.Configuration.filled()
    config.image = UIImage(systemName: "text.bubble")
    config.title = "Comment"
    config.imagePadding = 6
    config.cornerStyle = .capsule
    config.baseBackgroundColor = UIColor(white: 0.17, alpha: 1)
    config.baseForegroundColor = UIColor(white: 0.91, alpha: 1)
    button.configuration = config
    button.layer.shadowOpacity = 0.25
    button.layer.shadowRadius = 8
    button.layer.shadowOffset = CGSize(width: 0, height: 4)
    button.addTarget(self, action: #selector(togglePicking), for: .touchUpInside)
    button.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag(_:))))
    button.accessibilityIdentifier = "groundwork-comment"
    button.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(menu(_:))))
    view.addSubview(button)

    hint.text = "Tap what you want to comment on"
    style(hint)
    hint.isHidden = true
    view.addSubview(hint)

    highlight.layer.borderColor = UIColor(red: 0.05, green: 0.6, blue: 1, alpha: 1).cgColor
    highlight.layer.borderWidth = 2
    highlight.layer.cornerRadius = 4
    highlight.backgroundColor = UIColor(red: 0.05, green: 0.6, blue: 1, alpha: 0.08)
    highlight.isUserInteractionEnabled = false
    highlight.isHidden = true
    view.addSubview(highlight)

    style(toast)
    toast.isHidden = true
    view.addSubview(toast)

    view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pick(_:))))
    updateBadge()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if button.frame == .zero {
      let size = button.intrinsicContentSize
      let safe = view.safeAreaInsets
      button.frame = CGRect(x: view.bounds.width - size.width - 16, y: view.bounds.height - safe.bottom - size.height - 24, width: size.width, height: size.height)
    }
    let hintSize = hint.intrinsicContentSize
    hint.frame = CGRect(x: (view.bounds.width - hintSize.width) / 2, y: view.safeAreaInsets.top + 8, width: hintSize.width, height: hintSize.height)
  }

  private func style(_ label: PaddedLabel) {
    label.font = .systemFont(ofSize: 13, weight: .medium)
    label.textColor = UIColor(white: 0.91, alpha: 1)
    label.backgroundColor = UIColor(white: 0.17, alpha: 1)
    label.layer.cornerRadius = 8
    label.layer.masksToBounds = true
  }

  @objc private func drag(_ pan: UIPanGestureRecognizer) {
    let t = pan.translation(in: view)
    button.center = CGPoint(x: button.center.x + t.x, y: button.center.y + t.y)
    pan.setTranslation(.zero, in: view)
  }

  /// Long press: share waiting comments as a file (for testers without Groundwork), or hide the button.
  @objc private func menu(_ press: UILongPressGestureRecognizer) {
    guard press.state == .began else { return }
    let count = Outbox.count
    let sheet = UIAlertController(title: "Groundwork", message: count > 0 ? "\(count) \(count == 1 ? "comment waits" : "comments wait") to be sent." : nil, preferredStyle: .actionSheet)
    sheet.addAction(UIAlertAction(title: "Show comments", style: .default) { [weak self] _ in self?.showComments() })
    if count > 0 {
      sheet.addAction(UIAlertAction(title: "Share \(count) \(count == 1 ? "comment" : "comments") as a file", style: .default) { [weak self] _ in self?.share() })
    }
    sheet.addAction(UIAlertAction(title: "Hide the Comment button", style: .destructive) { _ in GroundworkFeedback.stop() })
    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    sheet.popoverPresentationController?.sourceView = button
    present(sheet, animated: true)
  }

  func showComments() {
    let list = CommentsController(overlay: self)
    let nav = UINavigationController(rootViewController: list)
    present(nav, animated: true)
  }

  /// One file with every waiting comment, pictures included. The person who
  /// runs Groundwork adds it with `groundwork import-feedback <file>`.
  func share(from presenter: UIViewController? = nil) {
    guard let (file, sent) = Outbox.export() else { return }
    let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
    activity.popoverPresentationController?.sourceView = presenter?.view ?? button
    activity.completionWithItemsHandler = { [weak self] _, completed, _, _ in
      guard completed else { return }
      // Shared: they are on their way, so they do not wait here any more.
      Outbox.remove(sent)
      self?.updateBadge()
      self?.flash("Shared. They will show up in Groundwork once imported.")
      (presenter as? CommentsController)?.reload()
    }
    (presenter ?? self).present(activity, animated: true)
  }

  @objc func togglePicking() {
    setPicking(!picking)
  }

  private func setPicking(_ on: Bool) {
    picking = on
    hint.isHidden = !on
    view.backgroundColor = on ? UIColor(white: 0, alpha: 0.06) : .clear
    var config = button.configuration
    config?.baseBackgroundColor = on ? UIColor(red: 0.05, green: 0.6, blue: 1, alpha: 1) : UIColor(white: 0.17, alpha: 1)
    config?.baseForegroundColor = on ? .white : UIColor(white: 0.91, alpha: 1)
    button.configuration = config
    if !on { highlight.isHidden = true }
  }

  @objc private func pick(_ tap: UITapGestureRecognizer) {
    guard picking else { return }
    comment(at: tap.location(in: view))
  }

  /// Pick the element at a point on screen and ask for the comment.
  func comment(at point: CGPoint, text: String? = nil) {
    guard let window = appWindow() else { return }
    let found = Inspector.element(at: point, in: window)
    setPicking(false)
    highlight.frame = found.frame.insetBy(dx: -3, dy: -3)
    highlight.isHidden = false
    let image = Inspector.crop(window, around: found.frame)
    let screen = Inspector.screen(of: window)

    let send: (String) -> Void = { [weak self] text in
      self?.highlight.isHidden = true
      Task { await self?.send(text: text, found: found, screen: screen, image: image) }
    }
    if let text { return send(text) }

    let alert = UIAlertController(title: "Comment on \(found.describe())", message: nil, preferredStyle: .alert)
    alert.addTextField { $0.placeholder = "What should change?" }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.highlight.isHidden = true })
    alert.addAction(UIAlertAction(title: "Send", style: .default) { _ in
      let text = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if text.isEmpty { self.highlight.isHidden = true } else { send(text) }
    })
    present(alert, animated: true)
  }

  private func send(text: String, found: Inspector.Found, screen: Inspector.Screen, image: Data?) async {
    var element: [String: String] = ["role": found.role]
    if let v = found.label { element["label"] = v }
    if let v = found.identifier { element["id"] = v }
    if let v = screen.component { element["component"] = v }
    var body: [String: Any] = ["text": text, "platform": "iOS", "screen": screen.name, "element": element, "written": ISO8601DateFormatter().string(from: Date())]
    if let image { body["image"] = "data:image/png;base64," + image.base64EncodedString() }
    guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }

    switch await Outbox.post(data) {
    case .sent(let id):
      Outbox.remember(data, id: id)
      flash("Sent to Groundwork")
      await Outbox.flush()
    case .rejected(let status):
      flash("Groundwork did not take it (\(status))")
    case .blockedByATS:
      flash("Blocked by App Transport Security. See the GroundworkFeedback README.")
    case .unreachable:
      Outbox.save(data)
      flash("Saved. It goes to Groundwork when it is running (\(Outbox.count) waiting)")
    }
    updateBadge()
  }

  /// "Comment · 2" while comments wait to be sent.
  func updateBadge() {
    var config = button.configuration
    config?.title = Outbox.count > 0 ? "Comment · \(Outbox.count)" : "Comment"
    config?.titleLineBreakMode = .byClipping
    button.configuration = config
    // Grow or shrink to the left, keeping the button where the person put it.
    guard button.frame != .zero else { return }
    let size = button.intrinsicContentSize
    button.frame = CGRect(x: button.frame.maxX - size.width, y: button.frame.minY, width: size.width, height: size.height)
  }

  func flash(_ text: String) {
    toast.text = text
    let size = toast.intrinsicContentSize
    let width = min(size.width, view.bounds.width - 32)
    toast.frame = CGRect(x: (view.bounds.width - width) / 2, y: view.bounds.height - view.safeAreaInsets.bottom - size.height - 80, width: width, height: size.height)
    toast.isHidden = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.toast.isHidden = true }
  }

  /// The app's own window, not this overlay.
  private func appWindow() -> UIWindow? {
    let windows = view.window?.windowScene?.windows ?? []
    return windows.first { $0 !== view.window && $0.isKeyWindow } ?? windows.first { $0 !== view.window && !$0.isHidden }
  }
}

final class PaddedLabel: UILabel {
  override var intrinsicContentSize: CGSize {
    let s = super.intrinsicContentSize
    return CGSize(width: s.width + 24, height: s.height + 12)
  }
  override func drawText(in rect: CGRect) { super.drawText(in: rect.insetBy(dx: 12, dy: 6)) }
}

// MARK: - Outbox

/// Comments that could not be sent yet, one JSON file each in Application
/// Support. Sent in the order they were written once Groundwork answers.
@MainActor
enum Outbox {
  enum Result { case sent(String), rejected(Int), blockedByATS, unreachable }

  /// A comment as the list shows it.
  struct Item {
    var file: URL?
    var text: String
    var detail: String
    var written: Date?
  }

  private static var flushing = false
  private static var dir: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("GroundworkFeedback/outbox", isDirectory: true)
  }
  private static var files: [URL] {
    let list = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
    return list.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  }
  static var count: Int { files.count }

  static func save(_ data: Data) {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let name = String(format: "%.0f", Date().timeIntervalSince1970 * 1000) + "-" + UUID().uuidString.prefix(6) + ".json"
    try? data.write(to: dir.appendingPathComponent(name))
  }

  static func post(_ data: Data) async -> Result {
    guard let server = await Locator.url() else { return .unreachable }
    var request = URLRequest(url: server.appendingPathComponent("api/feedback"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = data
    request.timeoutInterval = 10
    do {
      let (body, response) = try await URLSession.shared.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status == 201 {
        let id = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["id"] as? String
        return .sent(id ?? "")
      }
      // An old Groundwork without comments, or a server error: keep it for later.
      if status == 404 || status >= 500 {
        Locator.forget()
        return .unreachable
      }
      return .rejected(status)
    } catch let error as URLError where error.code == .appTransportSecurityRequiresSecureConnection {
      return .blockedByATS
    } catch {
      // Groundwork may have moved, or stopped: look for it again next time.
      Locator.forget()
      return .unreachable
    }
  }

  // Sent comments, so the person can look back at them. Without pictures, last 200.
  private static var sentFile: URL { dir.deletingLastPathComponent().appendingPathComponent("sent.json") }

  static func remember(_ data: Data, id: String) {
    guard var entry = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    entry["image"] = nil
    entry["node"] = id
    entry["sent"] = ISO8601DateFormatter().string(from: Date())
    var list = ((try? Data(contentsOf: sentFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
    list.append(entry)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    if let out = try? JSONSerialization.data(withJSONObject: Array(list.suffix(200))) { try? out.write(to: sentFile) }
  }

  static var waiting: [Item] {
    files.compactMap { file in
      (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }.map { item(from: $0, file: file) }
    }
  }

  static var sent: [Item] {
    let list = ((try? Data(contentsOf: sentFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
    return list.reversed().map { item(from: $0, file: nil) }
  }

  private static func item(from c: [String: Any], file: URL?) -> Item {
    let element = c["element"] as? [String: Any]
    let on = [element?["role"] as? String, (element?["label"] as? String).map { "\u{201C}\($0)\u{201D}" }].compactMap { $0 }.joined(separator: " ")
    var parts = [c["screen"] as? String, on.isEmpty ? nil : on].compactMap { $0 }
    if let node = c["node"] as? String, !node.isEmpty { parts.append(node) }
    let written = (c["written"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
    return Item(file: file, text: c["text"] as? String ?? "", detail: parts.joined(separator: " · "), written: written)
  }

  /// Every waiting comment in one file: { "groundwork": "feedback", "comments": [...] }.
  static func export() -> (URL, [URL])? {
    let list = files
    let comments = list.compactMap { (try? Data(contentsOf: $0)).flatMap { try? JSONSerialization.jsonObject(with: $0) } }
    guard !comments.isEmpty, let data = try? JSONSerialization.data(withJSONObject: ["groundwork": "feedback", "comments": comments]) else { return nil }
    let stamp = ISO8601DateFormatter().string(from: Date()).prefix(16).replacingOccurrences(of: ":", with: "")
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("groundwork-feedback-\(stamp).json")
    guard (try? data.write(to: url)) != nil else { return nil }
    return (url, list)
  }

  static func remove(_ list: [URL]) {
    for file in list { try? FileManager.default.removeItem(at: file) }
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
      case .sent(let id):
        remember(data, id: id)
        try? FileManager.default.removeItem(at: file)
        sent += 1
      case .rejected:
        // Sent, or refused for good: either way it should not be tried again.
        try? FileManager.default.removeItem(at: file)
        sent += 1
      case .unreachable, .blockedByATS:
        return
      }
    }
    if sent > 0 { GroundworkFeedback.didFlush(sent) }
  }
}

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

// MARK: - The list of comments

/// Waiting comments, which can be sent now, shared or deleted, and the ones already sent.
@MainActor
final class CommentsController: UITableViewController {
  private weak var overlay: OverlayController?
  private var waiting: [Outbox.Item] = []
  private var sent: [Outbox.Item] = []
  private let dates: DateFormatter = {
    let f = DateFormatter()
    f.dateStyle = .short
    f.timeStyle = .short
    return f
  }()

  init(overlay: OverlayController) {
    self.overlay = overlay
    super.init(style: .insetGrouped)
  }
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Comments"
    tableView.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    reload()
  }

  func reload() {
    waiting = Outbox.waiting
    sent = Outbox.sent
    var actions: [UIMenuElement] = []
    if !waiting.isEmpty {
      actions.append(UIAction(title: "Send now", image: UIImage(systemName: "paperplane")) { [weak self] _ in
        Task {
          await Outbox.flush()
          self?.reload()
          self?.overlay?.updateBadge()
          if !Outbox.waiting.isEmpty { self?.overlay?.flash("Groundwork is not reachable yet") }
        }
      })
      actions.append(UIAction(title: "Share as a file", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
        self?.overlay?.share(from: self)
      })
    }
    navigationItem.rightBarButtonItem = actions.isEmpty ? nil : UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: actions))
    tableView.reloadData()
  }

  override func numberOfSections(in tableView: UITableView) -> Int { 2 }

  override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
    section == 0 ? "Waiting to be sent (\(waiting.count))" : "Sent to Groundwork (\(sent.count))"
  }

  override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
    if section == 0 {
      if !waiting.isEmpty { return "They go by themselves once Groundwork is reachable. Or share them as a file." }
      return Locator.current.map { "Connected to Groundwork at \($0.host ?? "")." } ?? nil
    }
    return sent.isEmpty ? "Nothing sent yet." : "In Groundwork they are on the Feedback page, in a topic per screen."
  }

  override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    section == 0 ? waiting.count : sent.count
  }

  override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let item = indexPath.section == 0 ? waiting[indexPath.row] : sent[indexPath.row]
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    var content = UIListContentConfiguration.subtitleCell()
    content.text = item.text
    content.secondaryText = [item.detail, item.written.map { dates.string(from: $0) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    content.secondaryTextProperties.color = .secondaryLabel
    cell.contentConfiguration = content
    cell.selectionStyle = .none
    return cell
  }

  override func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard indexPath.section == 0, let file = waiting[indexPath.row].file else { return nil }
    let delete = UIContextualAction(style: .destructive, title: "Delete") { [weak self] _, _, done in
      Outbox.remove([file])
      self?.reload()
      self?.overlay?.updateBadge()
      done(true)
    }
    return UISwipeActionsConfiguration(actions: [delete])
  }
}

// MARK: - Finding what was tapped

@MainActor
enum Inspector {
  struct Found {
    var frame: CGRect
    var label: String?
    var identifier: String?
    var role: String

    func describe() -> String {
      label.map { "\(role) \u{201C}\($0.prefix(40))\u{201D}" } ?? role
    }
  }

  struct Screen {
    /// The navigation title when there is one, or the view controller's or SwiftUI view's name.
    var name: String
    /// The view type, like BookingView, when it can be read.
    var component: String?
  }

  /// The smallest accessibility element under the point: what VoiceOver would
  /// read there. Works for UIKit and SwiftUI. Falls back to the view under it.
  static func element(at point: CGPoint, in window: UIWindow) -> Found {
    var best: (NSObject, CGRect)?
    var visited = 0
    func visit(_ object: NSObject, depth: Int) {
      visited += 1
      guard depth < 60, visited < 5000 else { return }
      if let view = object as? UIView, view.isHidden || view.alpha < 0.01 { return }
      if object.isAccessibilityElement {
        let frame = object.accessibilityFrame
        if frame.contains(point), frame.width * frame.height < (best.map { $0.1.width * $0.1.height } ?? .infinity) {
          best = (object, frame)
        }
      }
      for child in children(of: object) { visit(child, depth: depth + 1) }
    }
    visit(window, depth: 0)

    if let (object, frame) = best {
      // SwiftUI's elements carry .accessibilityIdentifier without declaring the protocol, so ask by name too.
      let id = (object as? UIAccessibilityIdentification)?.accessibilityIdentifier
        ?? (object.responds(to: Selector(("accessibilityIdentifier"))) ? object.value(forKey: "accessibilityIdentifier") as? String : nil)
      let label = object.accessibilityLabel ?? object.accessibilityValue
      return Found(frame: frame, label: clean(label), identifier: clean(id), role: role(of: object.accessibilityTraits))
    }
    let view = window.hitTest(window.convert(point, from: nil), with: nil) ?? window
    return Found(frame: view.convert(view.bounds, to: nil), label: nil, identifier: clean(view.accessibilityIdentifier), role: String(describing: type(of: view)))
  }

  private static func children(of object: NSObject) -> [NSObject] {
    if let elements = object.accessibilityElements as? [NSObject], !elements.isEmpty { return elements }
    let count = object.accessibilityElementCount()
    if count != NSNotFound, count > 0 {
      return (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject }
    }
    return (object as? UIView)?.subviews ?? []
  }

  private static func role(of traits: UIAccessibilityTraits) -> String {
    if traits.contains(.button) { return "button" }
    if traits.contains(.link) { return "link" }
    if traits.contains(.searchField) { return "search field" }
    if traits.contains(.image) { return "image" }
    if traits.contains(.header) { return "heading" }
    if traits.contains(.adjustable) { return "slider" }
    if traits.contains(.tabBar) { return "tab bar" }
    if traits.contains(.staticText) { return "text" }
    return "element"
  }

  private static func clean(_ s: String?) -> String? {
    guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    return String(s.prefix(200))
  }

  static func screen(of window: UIWindow) -> Screen {
    var vc = window.rootViewController
    while true {
      if let presented = vc?.presentedViewController, !(presented is UIAlertController) { vc = presented }
      else if let nav = vc as? UINavigationController { vc = nav.visibleViewController ?? nav.topViewController }
      else if let tabs = vc as? UITabBarController { vc = tabs.selectedViewController }
      else if let child = vc?.children.last(where: { $0.isViewLoaded && $0.view.window != nil }), vc is UISplitViewController { vc = child }
      else { break }
    }
    let component = vc.flatMap { typeName(String(describing: type(of: $0))) }
    let title = vc?.navigationItem.title ?? vc?.title
    return Screen(name: clean(title) ?? component ?? "App", component: component)
  }

  /// "UIHostingController<ModifiedContent<BookingView, ...>>" gives BookingView.
  static func typeName(_ raw: String) -> String? {
    let wrappers: Set<String> = ["UIHostingController", "ModifiedContent", "AnyView", "Optional", "TupleView", "NavigationStack", "NavigationView", "Group", "VStack", "HStack", "ZStack", "EmptyView", "Never", "Text"]
    let words = raw.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "_" }).map(String.init)
    // Only wrappers, like UIHostingController<AnyView>: the view's name cannot be read.
    return words.first(where: { !wrappers.contains($0) && !$0.hasPrefix("_") && $0.first?.isUppercase == true && !$0.hasSuffix("Modifier") })
  }

  /// A picture of the area around the element, at most 2x, for context in the map.
  static func crop(_ window: UIWindow, around frame: CGRect) -> Data? {
    let area = frame.insetBy(dx: -48, dy: -48).intersection(window.bounds)
    guard !area.isNull, area.width > 1, area.height > 1 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = min(2, window.screen.scale)
    let image = UIGraphicsImageRenderer(bounds: area, format: format).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
    }
    return image.pngData()
  }
}

// MARK: - Self test

extension GroundworkFeedback {
  /// Send a comment on whatever sits at `point`, without tapping. For checking
  /// the setup from code or a launch argument: `-GroundworkSelfTest 200,400`.
  public static func comment(at point: CGPoint, text: String) {
    (overlay?.rootViewController as? OverlayController)?.comment(at: point, text: text)
  }
}
#endif
