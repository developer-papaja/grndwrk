#if canImport(UIKit)
import UIKit

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
  private let blue = UIColor(red: 0.05, green: 0.6, blue: 1, alpha: 1)
  private let dark = UIColor(white: 0.17, alpha: 1)
  private let button = UIButton(type: .system)
  /// Green when Groundwork answers, orange when comments wait on the phone.
  private let dot = UIView()
  private let hint = PaddedLabel()
  private let highlight = UIView()
  private let toast = PaddedLabel()
  private(set) var picking = false

  // What is picked: everything under the finger, smallest first, and which one is chosen.
  private var candidates: [Inspector.Found] = []
  private var chosen = 0
  private let bar = UIView()
  private let barLabel = UILabel()
  private var smaller = UIButton()
  private var bigger = UIButton()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear

    var config = UIButton.Configuration.filled()
    config.image = UIImage(systemName: "text.bubble")
    config.title = "Comment"
    config.imagePadding = 6
    config.cornerStyle = .capsule
    config.baseBackgroundColor = dark
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

    dot.frame = CGRect(x: 0, y: 0, width: 10, height: 10)
    dot.layer.cornerRadius = 5
    dot.layer.borderWidth = 1.5
    dot.layer.borderColor = dark.cgColor
    dot.isUserInteractionEnabled = false
    button.addSubview(dot)

    hint.text = "Tap what you want to comment on"
    style(hint)
    hint.isHidden = true
    view.addSubview(hint)

    highlight.layer.borderColor = blue.cgColor
    highlight.layer.borderWidth = 2
    highlight.layer.cornerRadius = 4
    highlight.backgroundColor = blue.withAlphaComponent(0.08)
    highlight.isUserInteractionEnabled = false
    highlight.isHidden = true
    view.addSubview(highlight)

    buildBar()

    style(toast)
    toast.numberOfLines = 0
    toast.isHidden = true
    view.addSubview(toast)

    view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pick(_:))))
    NotificationCenter.default.addObserver(forName: Connection.changed, object: nil, queue: .main) { [weak self] note in
      let before = note.userInfo?["before"] as? Connection.State
      MainActor.assumeIsolated { self?.connectionChanged(from: before) }
    }
    NotificationCenter.default.addObserver(forName: Outbox.changed, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateBadge() }
    }
    updateBadge()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if button.frame == .zero {
      let size = button.intrinsicContentSize
      let safe = view.safeAreaInsets
      button.frame = CGRect(x: view.bounds.width - size.width - 16, y: view.bounds.height - safe.bottom - size.height - 24, width: size.width, height: size.height)
    }
    dot.frame.origin = CGPoint(x: button.bounds.width - 12, y: 1)
    let hintSize = hint.intrinsicContentSize
    hint.frame = CGRect(x: (view.bounds.width - hintSize.width) / 2, y: view.safeAreaInsets.top + 8, width: hintSize.width, height: hintSize.height)
  }

  private func style(_ label: PaddedLabel) {
    label.font = .systemFont(ofSize: 13, weight: .medium)
    label.textColor = UIColor(white: 0.91, alpha: 1)
    label.backgroundColor = dark
    label.layer.cornerRadius = 8
    label.layer.masksToBounds = true
  }

  @objc private func drag(_ pan: UIPanGestureRecognizer) {
    let t = pan.translation(in: view)
    button.center = CGPoint(x: button.center.x + t.x, y: button.center.y + t.y)
    pan.setTranslation(.zero, in: view)
  }

  // MARK: Connection

  private func connectionChanged(from before: Connection.State?) {
    updateBadge()
    switch Connection.state {
    case .connected(let project, _):
      if case .connected = before { return }
      flash(project.isEmpty ? "Connected to Groundwork" : "Connected to Groundwork \u{201C}\(project)\u{201D}")
    case .offline:
      // Only say it when it was there a moment ago. The dot says the rest.
      if case .connected = before { flash("Lost Groundwork. Comments wait on the phone.") }
    case .unknown:
      break
    }
  }

  // MARK: Menu

  /// Long press: the list of comments, sharing waiting ones as a file (for testers without Groundwork), or hiding the button.
  @objc private func menu(_ press: UILongPressGestureRecognizer) {
    guard press.state == .began else { return }
    let count = Outbox.count
    var lines = [status()]
    if count > 0 { lines.append("\(count) \(count == 1 ? "comment waits" : "comments wait") to be sent.") }
    let sheet = UIAlertController(title: "Groundwork", message: lines.joined(separator: "\n"), preferredStyle: .actionSheet)
    sheet.addAction(UIAlertAction(title: "Show comments", style: .default) { [weak self] _ in self?.showComments() })
    if count > 0 {
      sheet.addAction(UIAlertAction(title: "Share \(count) \(count == 1 ? "comment" : "comments") as a file", style: .default) { [weak self] _ in self?.share() })
    }
    sheet.addAction(UIAlertAction(title: "Hide the Comment button", style: .destructive) { _ in GroundworkFeedback.stop() })
    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    sheet.popoverPresentationController?.sourceView = button
    present(sheet, animated: true)
  }

  /// The connection in words.
  func status() -> String {
    switch Connection.state {
    case .connected(let project, let host): return "Connected to \(project.isEmpty ? "Groundwork" : "\u{201C}\(project)\u{201D}") at \(host)."
    case .offline: return "Not connected. Comments wait on the phone."
    case .unknown: return "Looking for Groundwork..."
    }
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
      self?.flash("Shared. They will show up in Groundwork once imported.")
    }
    (presenter ?? self).present(activity, animated: true)
  }

  // MARK: Picking

  @objc func togglePicking() {
    setPicking(!picking)
  }

  private func setPicking(_ on: Bool) {
    picking = on
    hint.isHidden = !on
    view.backgroundColor = on ? UIColor(white: 0, alpha: 0.06) : .clear
    var config = button.configuration
    config?.baseBackgroundColor = on ? blue : dark
    config?.baseForegroundColor = on ? .white : UIColor(white: 0.91, alpha: 1)
    button.configuration = config
    if !on {
      highlight.isHidden = true
      bar.isHidden = true
      candidates = []
    }
  }

  @objc private func pick(_ tap: UITapGestureRecognizer) {
    guard picking else { return }
    let point = tap.location(in: view)
    if !bar.isHidden, bar.frame.contains(point) { return }
    select(at: point)
  }

  /// Everything under the point, with the smallest element chosen.
  func select(at point: CGPoint) {
    guard let window = appWindow() else { return }
    if !picking { setPicking(true) }
    candidates = Inspector.candidates(at: point, in: window)
    chosen = Inspector.preferred(candidates)
    hint.isHidden = true
    showChosen()
    // Nothing VoiceOver knows: ask iOS to build the tree, then look again.
    if Inspector.elementCount == 0, Inspector.wakeAccessibility() {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        guard let self, self.picking, let window = self.appWindow() else { return }
        self.candidates = Inspector.candidates(at: point, in: window)
        self.chosen = Inspector.preferred(self.candidates)
        self.showChosen()
      }
    }
  }

  /// A bar to make the selection smaller or bigger, and to comment on it.
  private func buildBar() {
    bar.backgroundColor = dark
    bar.layer.cornerRadius = 14
    bar.layer.shadowOpacity = 0.3
    bar.layer.shadowRadius = 10
    bar.layer.shadowOffset = CGSize(width: 0, height: 4)
    bar.isHidden = true

    func icon(_ name: String, _ label: String, _ action: @escaping () -> Void) -> UIButton {
      var c = UIButton.Configuration.plain()
      c.image = UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
      c.baseForegroundColor = UIColor(white: 0.91, alpha: 1)
      c.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
      let b = UIButton(configuration: c)
      b.accessibilityLabel = label
      b.addAction(UIAction { _ in action() }, for: .touchUpInside)
      return b
    }
    let close = icon("xmark", "Stop picking") { [weak self] in self?.setPicking(false) }
    smaller = icon("arrow.down.right.and.arrow.up.left", "Smaller") { [weak self] in self?.step(-1) }
    bigger = icon("arrow.up.left.and.arrow.down.right", "Bigger") { [weak self] in self?.step(1) }

    barLabel.font = .systemFont(ofSize: 13, weight: .medium)
    barLabel.textColor = UIColor(white: 0.91, alpha: 1)
    barLabel.lineBreakMode = .byTruncatingTail
    barLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    var c = UIButton.Configuration.filled()
    c.title = "Comment"
    c.baseBackgroundColor = blue
    c.cornerStyle = .capsule
    c.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 12, bottom: 7, trailing: 12)
    let go = UIButton(configuration: c)
    go.setContentCompressionResistancePriority(.required, for: .horizontal)
    go.addAction(UIAction { [weak self] _ in self?.compose() }, for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [close, barLabel, smaller, bigger, go])
    stack.spacing = 2
    stack.alignment = .center
    stack.translatesAutoresizingMaskIntoConstraints = false
    bar.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 4),
      stack.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -6),
      stack.topAnchor.constraint(equalTo: bar.topAnchor, constant: 4),
      stack.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -4),
    ])
    view.addSubview(bar)
  }

  func step(_ by: Int) {
    chosen = max(0, min(candidates.count - 1, chosen + by))
    showChosen()
  }

  private func showChosen() {
    guard candidates.indices.contains(chosen) else { return }
    let found = candidates[chosen]
    UIView.animate(withDuration: 0.15) {
      self.highlight.frame = found.frame.insetBy(dx: -3, dy: -3)
    }
    highlight.isHidden = false
    barLabel.text = found.describe()
    smaller.isEnabled = chosen > 0
    bigger.isEnabled = chosen < candidates.count - 1
    // The bar sits at the top or the bottom, away from what is picked.
    let width = view.bounds.width - 24
    let height: CGFloat = 46
    let safe = view.safeAreaInsets
    let below = found.frame.midY < view.bounds.midY
    let y = below ? view.bounds.height - safe.bottom - height - 12 : safe.top + 8
    bar.frame = CGRect(x: 12, y: y, width: width, height: height)
    bar.isHidden = false
    view.bringSubviewToFront(bar)
  }

  /// Ask for the comment on what is picked.
  func compose() {
    guard candidates.indices.contains(chosen), let window = appWindow() else { return }
    let found = candidates[chosen]
    let screen = Inspector.screen(of: window)
    // The picture first, without the highlight in it.
    let image = Inspector.crop(window, around: found.frame)
    setPicking(false)
    highlight.frame = found.frame.insetBy(dx: -3, dy: -3)
    highlight.isHidden = false

    let sheet = ComposeController(found: found, screen: screen, image: image)
    sheet.onSend = { [weak self] text in
      guard let data = Outbox.comment(text: text, found: found, screen: screen, image: image) else { return }
      Task { await self?.send(data) }
    }
    sheet.onMac = { [weak self] in
      guard let data = Outbox.comment(text: "", found: found, screen: screen, image: image, onMac: true) else { return "Could not prepare it." }
      switch await Outbox.post(data) {
      case .sent(let id, let project):
        Outbox.remember(data, id: id, project: project)
        self?.flash("Opened on your Mac. Write it there.")
        return nil
      case .rejected(let status): return "Groundwork did not take it (\(status))."
      case .blockedByATS: return "Blocked by App Transport Security. See the GroundworkFeedback README."
      case .unreachable: return "Groundwork is not reachable. Write it here instead, and it goes once it is."
      }
    }
    sheet.onClose = { [weak self] in self?.highlight.isHidden = true }
    let nav = UINavigationController(rootViewController: sheet)
    if let presentation = nav.sheetPresentationController {
      presentation.detents = [.medium(), .large()]
      presentation.prefersGrabberVisible = true
    }
    present(nav, animated: true)
  }

  /// Pick the element at a point on screen and send a comment on it, without asking. For the self test.
  func comment(at point: CGPoint, text: String) {
    guard let window = appWindow() else { return }
    let found = Inspector.element(at: point, in: window)
    let image = Inspector.crop(window, around: found.frame)
    guard let data = Outbox.comment(text: text, found: found, screen: Inspector.screen(of: window), image: image) else { return }
    Task { await send(data) }
  }

  private func send(_ data: Data) async {
    switch await Outbox.post(data) {
    case .sent(let id, let project):
      Outbox.remember(data, id: id, project: project)
      flash("Sent to Groundwork")
      await Outbox.flush()
    case .rejected(let status):
      flash("Groundwork did not take it (\(status))")
    case .blockedByATS:
      flash("Blocked by App Transport Security. See the GroundworkFeedback README.")
    case .unreachable:
      Outbox.save(data)
      flash("Saved on the phone. It goes to Groundwork once connected (\(Outbox.count) waiting)")
    }
    updateBadge()
  }

  // MARK: Badge and messages

  /// "Comment · 2" while comments wait to be sent, "Offline · 2" while Groundwork
  /// cannot be reached, and the dot: green when connected, orange when not.
  func updateBadge() {
    var config = button.configuration
    // Offline, the button says so in words, so nobody wonders where comments went.
    let offline = Connection.state == .offline
    let name = offline ? "Offline" : "Comment"
    config?.title = Outbox.count > 0 ? "\(name) · \(Outbox.count)" : name
    config?.image = UIImage(systemName: offline ? "wifi.slash" : "text.bubble")
    config?.titleLineBreakMode = .byClipping
    button.configuration = config
    switch Connection.state {
    case .connected: dot.backgroundColor = .systemGreen
    case .offline: dot.backgroundColor = .systemOrange
    case .unknown: dot.backgroundColor = .systemGray
    }
    button.accessibilityValue = status()
    // Grow or shrink to the left, keeping the button where the person put it.
    guard button.frame != .zero else { return }
    let size = button.intrinsicContentSize
    button.frame = CGRect(x: button.frame.maxX - size.width, y: button.frame.minY, width: size.width, height: size.height)
    dot.frame.origin = CGPoint(x: button.bounds.width - 12, y: 1)
  }

  func flash(_ text: String) {
    toast.text = text
    let width = min(toast.intrinsicContentSize.width, view.bounds.width - 32)
    let height = toast.sizeThatFits(CGSize(width: width - 24, height: .greatestFiniteMagnitude)).height + 12
    toast.frame = CGRect(x: (view.bounds.width - width) / 2, y: view.bounds.height - view.safeAreaInsets.bottom - height - 80, width: width, height: height)
    toast.isHidden = false
    view.bringSubviewToFront(toast)
    let shown = text
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) { [weak self] in
      if self?.toast.text == shown { self?.toast.isHidden = true }
    }
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
#endif
