#if canImport(UIKit)
import UIKit

/// Lets touches through to the app except on the grndwrk button, or everywhere while picking.
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
  private var snapshotTimer: Timer?
  /// Green when grndwrk answers, orange when comments wait on the phone.
  private let dot = UIView()
  /// Above the grndwrk button when fixes are ready: "2 to test". Opens the list.
  private let testPill = UIButton()
  /// While testing a fix: what changed, how to test it, Approve and Reject, over the app.
  private let testCard = UIView()
  private let testStack = UIStackView()
  private(set) var testing: Outbox.Item?
  /// Where the card's top sits, from the top of the safe area. Dragged by the person, kept for the next test.
  private var cardTop: NSLayoutConstraint?
  private var cardOffset: CGFloat = 8
  private let grabber = UIView()
  /// Shown on the grndwrk button for a moment when a picture of the screen was taken.
  private let camera = UIImageView(image: UIImage(systemName: "camera.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .bold)))
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
  /// An area the person framed with the handles: wins over the candidates until smaller or bigger is used.
  private var custom: Inspector.Found?
  /// Corner handles on the blue box, to frame any area by hand.
  private var handles: [UIView] = []
  /// Where the box was when a drag began.
  private var dragStart = CGRect.zero
  private var picked: Inspector.Found? { custom ?? (candidates.indices.contains(chosen) ? candidates[chosen] : nil) }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear

    var config = UIButton.Configuration.filled()
    config.image = UIImage(systemName: "text.bubble")
    config.title = "grndwrk"
    config.imagePadding = 6
    config.cornerStyle = .capsule
    // At least 44 points high, the size iOS asks for anything tapped.
    config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
    config.baseBackgroundColor = dark
    config.baseForegroundColor = UIColor(white: 0.91, alpha: 1)
    button.configuration = config
    button.layer.shadowOpacity = 0.25
    button.layer.shadowRadius = 8
    button.layer.shadowOffset = CGSize(width: 0, height: 4)
    button.addTarget(self, action: #selector(togglePicking), for: .touchUpInside)
    button.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag(_:))))
    button.accessibilityIdentifier = "grndwrk-comment"
    button.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(menu(_:))))
    view.addSubview(button)

    dot.frame = CGRect(x: 0, y: 0, width: 10, height: 10)
    dot.layer.cornerRadius = 5
    dot.layer.borderWidth = 1.5
    dot.layer.borderColor = dark.cgColor
    dot.isUserInteractionEnabled = false
    button.addSubview(dot)

    camera.tintColor = .white
    camera.backgroundColor = blue
    camera.contentMode = .center
    camera.frame = CGRect(x: 0, y: 0, width: 18, height: 18)
    camera.layer.cornerRadius = 9
    camera.clipsToBounds = true
    camera.alpha = 0
    camera.isUserInteractionEnabled = false
    camera.accessibilityLabel = "Picture taken"
    button.addSubview(camera)
    NotificationCenter.default.addObserver(forName: Snapshots.tookPicture, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.blinkCamera() }
    }

    hint.text = "Tap what you want to comment on"
    style(hint)
    hint.isHidden = true
    view.addSubview(hint)

    highlight.layer.borderColor = blue.cgColor
    highlight.layer.borderWidth = 2
    highlight.layer.cornerRadius = 4
    highlight.backgroundColor = blue.withAlphaComponent(0.08)
    highlight.isUserInteractionEnabled = true
    highlight.isHidden = true
    // Dragging inside the box moves it.
    highlight.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(moveBox(_:))))
    view.addSubview(highlight)
    for corner in 0..<4 {
      // A dot to see, in a larger area to grab.
      let handle = UIView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
      handle.tag = corner
      let knob = UIView(frame: CGRect(x: 13, y: 13, width: 18, height: 18))
      knob.backgroundColor = .white
      knob.layer.cornerRadius = 9
      knob.layer.borderColor = blue.cgColor
      knob.layer.borderWidth = 2.5
      knob.layer.shadowOpacity = 0.25
      knob.layer.shadowRadius = 3
      knob.layer.shadowOffset = CGSize(width: 0, height: 1)
      knob.isUserInteractionEnabled = false
      handle.addSubview(knob)
      handle.isHidden = true
      handle.accessibilityLabel = ["Top left", "Top right", "Bottom left", "Bottom right"][corner] + " corner of the selection"
      handle.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(resizeBox(_:))))
      view.addSubview(handle)
      handles.append(handle)
    }

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
    NotificationCenter.default.addObserver(forName: Outbox.newFixes, object: nil, queue: .main) { [weak self] note in
      let count = note.userInfo?["count"] as? Int ?? 0
      MainActor.assumeIsolated {
        self?.flash(count == 1 ? "A fix is ready to test" : "\(count) fixes are ready to test")
        self?.updateTestPill()
      }
    }
    buildTesting()
    buildTab()
    updateBadge()
    // Pictures of the screens as the app is used, for the sitemap.
    snapshotTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, UIApplication.shared.applicationState == .active else { return }
        Snapshots.tick(window: self.appWindow(), busy: self.picking || self.presentedViewController != nil)
      }
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if button.frame == .zero {
      let size = minimumTap(button.intrinsicContentSize)
      let safe = view.safeAreaInsets
      button.frame = CGRect(x: view.bounds.width - size.width - 16, y: view.bounds.height - safe.bottom - size.height - 24, width: size.width, height: size.height)
    }
    dot.frame.origin = CGPoint(x: button.bounds.width - 12, y: 1)
    camera.frame.origin = CGPoint(x: -4, y: -6)
    let hintSize = hint.intrinsicContentSize
    hint.frame = CGRect(x: (view.bounds.width - hintSize.width) / 2, y: view.safeAreaInsets.top + 8, width: hintSize.width, height: hintSize.height)
    layoutTestPill()
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
    layoutTestPill()
    guard pan.state == .ended else { return }
    // Flicked or pushed against a side: tuck it away there, like a video in picture in picture.
    let speed = pan.velocity(in: view).x
    if button.frame.maxX > view.bounds.width + button.bounds.width * 0.25 || (speed > 900 && button.center.x > view.bounds.midX) {
      stash(.right)
    } else if button.frame.minX < -button.bounds.width * 0.25 || (speed < -900 && button.center.x < view.bounds.midX) {
      stash(.left)
    } else {
      // Back fully on the screen.
      let safe = view.safeAreaInsets
      var f = button.frame
      f.origin.x = max(8, min(f.origin.x, view.bounds.width - f.width - 8))
      f.origin.y = max(safe.top + 8, min(f.origin.y, view.bounds.height - safe.bottom - f.height - 8))
      UIView.animate(withDuration: 0.2) {
        self.button.frame = f
        self.layoutTestPill()
      }
    }
  }

  // MARK: Tucked away at a side

  enum Side { case left, right }
  /// The side the button is tucked into, or nil when it is out.
  private(set) var stashed: Side?
  /// What shows of it while tucked away: a tab on the edge to pull it back.
  private let edgeTab = UIView()
  /// Where the button was before it was tucked away, to come back to.
  private var beforeStash = CGRect.zero

  private func buildTab() {
    edgeTab.backgroundColor = dark
    edgeTab.layer.cornerRadius = 10
    edgeTab.layer.shadowOpacity = 0.3
    edgeTab.layer.shadowRadius = 6
    edgeTab.isHidden = true
    edgeTab.isAccessibilityElement = true
    edgeTab.accessibilityLabel = "grndwrk"
    edgeTab.accessibilityHint = "Brings the grndwrk button back"
    let line = UIView(frame: CGRect(x: 0, y: 0, width: 4, height: 28))
    line.backgroundColor = UIColor(white: 1, alpha: 0.6)
    line.layer.cornerRadius = 2
    line.tag = 1
    line.isUserInteractionEnabled = false
    edgeTab.addSubview(line)
    edgeTab.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(unstashTapped)))
    edgeTab.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pullTab(_:))))
    view.addSubview(edgeTab)
  }

  func stash(_ side: Side) {
    if stashed == nil { beforeStash = button.frame }
    stashed = side
    if beforeStash.minX < 8 || beforeStash.maxX > view.bounds.width - 8 {
      // Thrown from off the screen: come back fully on it, on that side.
      beforeStash.origin.x = side == .right ? view.bounds.width - beforeStash.width - 16 : 16
    }
    let y = min(max(button.frame.minY, view.safeAreaInsets.top + 8), view.bounds.height - view.safeAreaInsets.bottom - button.bounds.height - 8)
    beforeStash.origin.y = y
    // A tab half off the edge, wide enough to grab: 44 points tall at least.
    let tabFrame = CGRect(x: side == .right ? view.bounds.width - 18 : -10, y: y + (button.bounds.height - 64) / 2, width: 28, height: 64)
    edgeTab.frame = tabFrame
    if let line = edgeTab.viewWithTag(1) { line.center = CGPoint(x: side == .right ? 9 : 19, y: 32) }
    edgeTab.isHidden = false
    edgeTab.alpha = 0
    updateTestPill()
    UIView.animate(withDuration: 0.25, delay: 0, options: .curveEaseOut) {
      self.button.frame.origin.x = side == .right ? self.view.bounds.width + 12 : -self.button.bounds.width - 12
      self.button.frame.origin.y = y
      self.edgeTab.alpha = 1
    }
  }

  @objc private func unstashTapped() { unstash() }

  func unstash() {
    guard stashed != nil else { return }
    stashed = nil
    UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0.5) {
      self.button.frame = self.beforeStash
      self.edgeTab.alpha = 0
    } completion: { _ in
      self.edgeTab.isHidden = true
      self.updateTestPill()
    }
  }

  /// Pulling the tab away from the edge brings the button out.
  @objc private func pullTab(_ pan: UIPanGestureRecognizer) {
    let dx = pan.translation(in: view).x
    let outward = stashed == .right ? -dx : dx
    if outward > 24 || pan.state == .ended {
      pan.isEnabled = false
      pan.isEnabled = true
      unstash()
    }
  }

  // MARK: Connection

  private func connectionChanged(from before: Connection.State?) {
    updateBadge()
    switch Connection.state {
    case .connected(let project, _):
      if case .connected = before { return }
      flash(project.isEmpty ? "Connected to grndwrk" : "Connected to grndwrk \u{201C}\(project)\u{201D}")
    case .offline:
      // Only say it when it was there a moment ago. The dot says the rest.
      if case .connected = before { flash("Lost grndwrk. Comments wait on the phone.") }
    case .needsCode:
      // Ask once when it starts wanting the code, not every time it checks.
      if case .needsCode = before { return }
      pair()
    case .unknown:
      break
    }
  }

  private var pairing = false

  /// Ask the person at the Mac to allow this phone. Without the map open on
  /// the Mac, or without an answer, ask for the code from the terminal instead.
  func pair() {
    guard case .needsCode(let project, _) = Connection.state, !pairing else { return }
    pairing = true
    flash("Asking grndwrk on your Mac")
    Task {
      let asked = await Pairing.ask(project: project) { [weak self] digits in
        self?.flash("Click Allow on your Mac, next to \(digits)")
      }
      pairing = false
      switch asked {
      case .allowed(let code, let digits): confirmPairing(project: project, code: code, digits: digits)
      case .denied: flash("Not allowed on the Mac. Long press the grndwrk button to ask again.")
      case .noBrowser: askForCode(message: "Open grndwrk in the browser on the Mac to allow this phone, or enter the code it shows in the terminal.")
      case .unanswered: askForCode(message: "Nobody answered on the Mac. Enter the code grndwrk shows in the terminal, or ask again.")
      }
    }
  }

  /// Something on the Wi-Fi could answer as grndwrk and allow at once.
  /// Only the person knows whether they clicked Allow on their own Mac.
  private func confirmPairing(project: String, code: String, digits: String) {
    var host: UIViewController = self
    while let next = host.presentedViewController { host = next }
    let alert = UIAlertController(
      title: "Did you allow it on your Mac?",
      message: "grndwrk on your Mac showed this phone with the digits \(digits). Pair only if you clicked Allow there yourself.",
      preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "No", style: .cancel) { [weak self] _ in
      gwLog.error("Pairing answered without the person allowing it on their Mac; the code was dropped")
      self?.flash("Not paired. Something else on this Wi-Fi may be posing as grndwrk.")
    })
    alert.addAction(UIAlertAction(title: "Yes, I allowed \(digits)", style: .default) { _ in
      Pairing.save(code, for: project)
      Task { await Connection.check() }
    })
    host.present(alert, animated: true)
  }

  /// Ask for the pairing code `grndwrk --lan` prints in the terminal.
  func askForCode(from presenter: UIViewController? = nil, message: String? = nil) {
    guard case .needsCode(let project, _) = Connection.state else { return }
    // On top of whatever is open, like the list of comments.
    var host: UIViewController = presenter ?? self
    while let next = host.presentedViewController { host = next }
    if host is UIAlertController { return }
    let alert = UIAlertController(
      title: "Pairing code",
      message: message ?? "Enter the code grndwrk\(project.isEmpty ? "" : " \u{201C}\(project)\u{201D}") shows in the terminal on the Mac. You only need it once.",
      preferredStyle: .alert)
    alert.addTextField { field in
      field.placeholder = "ABC234"
      field.autocapitalizationType = .allCharacters
      field.autocorrectionType = .no
      field.spellCheckingType = .no
    }
    alert.addAction(UIAlertAction(title: "Not now", style: .cancel))
    alert.addAction(UIAlertAction(title: "Ask the Mac", style: .default) { [weak self] _ in self?.pair() })
    alert.addAction(UIAlertAction(title: "Pair", style: .default) { [weak self] _ in
      Pairing.save(alert.textFields?.first?.text ?? "", for: project)
      Task {
        await Connection.check()
        if case .needsCode = Connection.state { self?.flash("That code did not work. Long press the grndwrk button to try again.") }
      }
    })
    host.present(alert, animated: true)
  }

  // MARK: Menu

  /// Long press: the list of comments, sharing waiting ones as a file (for testers without grndwrk), or hiding the button.
  @objc private func menu(_ press: UILongPressGestureRecognizer) {
    guard press.state == .began else { return }
    let count = Outbox.count
    var lines = [status(), Snapshots.status(window: appWindow())].filter { !$0.isEmpty }
    if count > 0 { lines.append("\(count) \(count == 1 ? "comment waits" : "comments wait") to be sent.") }
    let sheet = UIAlertController(title: "grndwrk", message: lines.joined(separator: "\n"), preferredStyle: .actionSheet)
    if case .needsCode = Connection.state {
      sheet.addAction(UIAlertAction(title: "Pair with the Mac", style: .default) { [weak self] _ in self?.pair() })
      sheet.addAction(UIAlertAction(title: "Enter pairing code", style: .default) { [weak self] _ in self?.askForCode() })
    }
    let fixes = Outbox.toTest.count
    if fixes > 0 {
      sheet.addAction(UIAlertAction(title: fixes == 1 ? "Test 1 fix" : "Test \(fixes) fixes", style: .default) { [weak self] _ in self?.showComments(.toTest) })
    }
    sheet.addAction(UIAlertAction(title: "Show comments", style: .default) { [weak self] _ in self?.showComments() })
    if Snapshots.enabled, case .connected = Connection.state {
      sheet.addAction(UIAlertAction(title: "Take a picture of this screen", style: .default) { [weak self] _ in
        Snapshots.takeNow(window: self?.appWindow())
      })
    }
    if count > 0 {
      sheet.addAction(UIAlertAction(title: "Share \(count) \(count == 1 ? "comment" : "comments") as a file", style: .default) { [weak self] _ in self?.share() })
    }
    sheet.addAction(UIAlertAction(title: "Hide the grndwrk button", style: .destructive) { [weak self] _ in self?.confirmHide() })
    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    sheet.popoverPresentationController?.sourceView = button
    present(sheet, animated: true)
  }

  /// The connection in words.
  func status() -> String {
    switch Connection.state {
    case .connected(let project, let host): return "Connected to \(project.isEmpty ? "grndwrk" : "\u{201C}\(project)\u{201D}") at \(host)."
    case .needsCode(let project, let host): return "\(project.isEmpty ? "grndwrk" : "\u{201C}\(project)\u{201D}") at \(host) needs the pairing code. Comments wait on the phone."
    case .offline(let why): return "Not connected. \(why) Comments wait on the phone."
    case .unknown: return "Looking for grndwrk..."
    }
  }

  func showComments(_ list: CommentsController.Mode = .overview) {
    let root = CommentsController(overlay: self, mode: .overview)
    let nav = UINavigationController(rootViewController: root)
    if list != .overview { nav.pushViewController(CommentsController(overlay: self, mode: list), animated: false) }
    present(nav, animated: true)
  }

  // MARK: Testing a fix

  private func buildTesting() {
    // The right part of the same capsule: the test icon and how many, on the button's own background.
    var c = UIButton.Configuration.plain()
    c.image = UIImage(systemName: "checkmark.seal", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
    c.imagePadding = 5
    c.baseForegroundColor = UIColor(white: 0.91, alpha: 1)
    c.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 16)
    testPill.configuration = c
    divider.backgroundColor = UIColor(white: 1, alpha: 0.25)
    divider.isUserInteractionEnabled = false
    testPill.isHidden = true
    testPill.accessibilityHint = "Opens the fixes that are ready to test"
    testPill.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      // One fix: straight to testing it. More: the list to choose from.
      let ready = Outbox.toTest
      if ready.count == 1 { self.startTesting(ready[0]) } else { self.showComments(.toTest) }
    }, for: .touchUpInside)
    view.addSubview(testPill)
    view.addSubview(divider)

    testCard.backgroundColor = dark
    testCard.layer.cornerRadius = 20
    testCard.layer.shadowOpacity = 0.3
    testCard.layer.shadowRadius = 10
    testCard.layer.shadowOffset = CGSize(width: 0, height: 4)
    testCard.isHidden = true
    testStack.axis = .vertical
    testStack.spacing = 8
    testStack.translatesAutoresizingMaskIntoConstraints = false
    testCard.addSubview(testStack)
    NSLayoutConstraint.activate([
      testStack.leadingAnchor.constraint(equalTo: testCard.leadingAnchor, constant: 16),
      testStack.trailingAnchor.constraint(equalTo: testCard.trailingAnchor, constant: -10),
      testStack.topAnchor.constraint(equalTo: testCard.topAnchor, constant: 16),
      testStack.bottomAnchor.constraint(equalTo: testCard.bottomAnchor, constant: -12),
    ])
    view.addSubview(testCard)
    // Sized by its content, never more than most of the screen, and dragged up
    // or down by the person, so it never sits on what they are testing.
    testCard.translatesAutoresizingMaskIntoConstraints = false
    let top = testCard.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: cardOffset)
    cardTop = top
    grabber.backgroundColor = UIColor(white: 1, alpha: 0.3)
    grabber.layer.cornerRadius = 2.5
    grabber.isUserInteractionEnabled = false
    grabber.translatesAutoresizingMaskIntoConstraints = false
    testCard.addSubview(grabber)
    testCard.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(moveCard(_:))))
    testCard.accessibilityHint = "Drag to move it up or down"
    NSLayoutConstraint.activate([
      grabber.topAnchor.constraint(equalTo: testCard.topAnchor, constant: 6),
      grabber.centerXAnchor.constraint(equalTo: testCard.centerXAnchor),
      grabber.widthAnchor.constraint(equalToConstant: 36),
      grabber.heightAnchor.constraint(equalToConstant: 5),
      top,
      testCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      testCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      testCard.heightAnchor.constraint(lessThanOrEqualTo: view.heightAnchor, multiplier: 0.6),
    ])
    NotificationCenter.default.addObserver(forName: Outbox.changed, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateTestPill() }
    }
    updateTestPill()
  }

  func updateTestPill() {
    let count = Outbox.toTest.count
    testPill.configuration?.title = "\(count)"
    testPill.accessibilityLabel = count == 1 ? "1 fix to test" : "\(count) fixes to test"
    testPill.isHidden = count == 0 || testing != nil || picking || button.isHidden || stashed != nil
    divider.isHidden = testPill.isHidden
    edgeTab.backgroundColor = dark
    // The button makes room on its right for the test part, then both are placed.
    updateBadge()
  }

  /// The line between the comment part and the test part of the button.
  private let divider = UIView()
  /// Room the test part takes at the right end of the button, or nothing when there is nothing to test.
  private var testRoom: CGFloat { testPill.isHidden ? 0 : testPill.intrinsicContentSize.width + 1 }

  private func layoutTestPill() {
    let width = testPill.intrinsicContentSize.width
    testPill.frame = CGRect(x: button.frame.maxX - width, y: button.frame.minY, width: width, height: button.frame.height)
    divider.frame = CGRect(x: testPill.frame.minX - 1, y: button.frame.midY - 11, width: 1, height: 22)
    view.bringSubviewToFront(testPill)
    view.bringSubviewToFront(divider)
  }

  /// Test one fix: the list closes, the app goes to the screen when it can,
  /// and a card stays on top with what changed, the steps, Approve and Reject.
  func startTesting(_ item: Outbox.Item) {
    testing = item
    dismiss(animated: true)
    var opened = false
    if let name = item.screen, let open = GrndwrkFeedback.openScreen { opened = open(name) }
    buildCard(item, opened: opened)
    updateTestPill()
  }

  private func stopTesting() {
    testing = nil
    testCard.isHidden = true
    updateTestPill()
  }

  private var cardOpen = true

  private func buildCard(_ item: Outbox.Item, opened: Bool) {
    testStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    let light = UIColor(white: 0.91, alpha: 1)
    func text(_ t: String, _ size: CGFloat, _ weight: UIFont.Weight, _ color: UIColor) -> UILabel {
      let l = UILabel()
      l.text = t
      l.font = .systemFont(ofSize: size, weight: weight)
      l.textColor = color
      l.numberOfLines = 0
      return l
    }
    func small(_ icon: String, _ label: String, _ action: @escaping () -> Void) -> UIButton {
      var c = UIButton.Configuration.plain()
      c.image = UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold))
      c.baseForegroundColor = light
      let b = UIButton(configuration: c, primaryAction: UIAction { _ in action() })
      b.accessibilityLabel = label
      b.widthAnchor.constraint(equalToConstant: 44).isActive = true
      b.heightAnchor.constraint(equalToConstant: 44).isActive = true
      return b
    }
    let title = text("Testing: \(item.text)", 15, .semibold, light)
    title.numberOfLines = 2
    let fold = small(cardOpen ? "chevron.up" : "chevron.down", cardOpen ? "Show less" : "Show the steps") { [weak self] in
      guard let self else { return }
      self.cardOpen.toggle()
      self.buildCard(item, opened: opened)
    }
    let close = small("xmark", "Stop testing") { [weak self] in self?.stopTesting() }
    // The comment in grndwrk on the Mac, with its whole thread and what changed.
    let mac = small("desktopcomputer", "Show on my Mac") { [weak self] in
      guard let node = item.node else { return }
      Task {
        let ok = await Outbox.showOnMac(node: node)
        self?.flash(ok ? "Open on your Mac" : "grndwrk is not reachable. Try again when connected.")
      }
    }
    let top = UIStackView(arrangedSubviews: [title, mac, fold, close])
    top.alignment = .center
    testStack.addArrangedSubview(top)

    if cardOpen {
      if !opened {
        testStack.addArrangedSubview(text(item.screen.map { "Go to \($0) in the app." } ?? "Go to where the comment was made.", 14, .semibold, light))
      }
      if let fix = item.fix, !fix.isEmpty {
        testStack.addArrangedSubview(text("What changed", 11, .semibold, light.withAlphaComponent(0.55)))
        testStack.addArrangedSubview(text(fix, 14, .regular, light))
      }
      testStack.addArrangedSubview(text("To test", 11, .semibold, light.withAlphaComponent(0.55)))
      testStack.addArrangedSubview(text(item.test?.isEmpty == false ? item.test! : "Try what the comment was about, and see whether it is right now.", 14, .regular, light))
    }

    func action(_ title: String, _ color: UIColor, filled: Bool, _ run: @escaping () -> Void) -> UIButton {
      var c: UIButton.Configuration = filled ? .filled() : .tinted()
      c.title = title
      c.cornerStyle = .capsule
      c.baseBackgroundColor = color
      c.baseForegroundColor = filled ? .white : color
      c.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
      let b = UIButton(configuration: c, primaryAction: UIAction { _ in run() })
      b.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
      return b
    }
    let reject = action("Reject", .systemRed, filled: false) { [weak self] in self?.rejectTested(item) }
    let approve = action("Approve: it works", .systemGreen, filled: true) { [weak self] in self?.sendTested(item, works: true) }
    let row = UIStackView(arrangedSubviews: [reject, UIView(), approve])
    row.alignment = .center
    row.spacing = 8
    if let last = testStack.arrangedSubviews.last { testStack.setCustomSpacing(16, after: last) }
    testStack.addArrangedSubview(row)

    testCard.isHidden = false
    view.bringSubviewToFront(testCard)
    // Folding or unfolding changes its height: keep it on the screen where it was put.
    view.layoutIfNeeded()
    let room = view.bounds.height - view.safeAreaInsets.top - view.safeAreaInsets.bottom - testCard.bounds.height - 8
    cardOffset = max(8, min(cardOffset, room))
    cardTop?.constant = cardOffset
  }

  @objc private func moveCard(_ pan: UIPanGestureRecognizer) {
    let move = pan.translation(in: view).y
    pan.setTranslation(.zero, in: view)
    let room = view.bounds.height - view.safeAreaInsets.top - view.safeAreaInsets.bottom - testCard.bounds.height - 8
    cardOffset = max(8, min(cardOffset + move, room))
    cardTop?.constant = cardOffset
  }

  private func rejectTested(_ item: Outbox.Item) {
    let alert = UIAlertController(title: "Reject", message: "What is still wrong? It goes back to grndwrk with the comment, for the next /feedback.", preferredStyle: .alert)
    alert.addTextField { $0.placeholder = "Optional" }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Reject", style: .destructive) { [weak self] _ in
      self?.sendTested(item, works: false, note: alert.textFields?.first?.text ?? "")
    })
    present(alert, animated: true)
  }

  private func sendTested(_ item: Outbox.Item, works: Bool, note: String = "") {
    guard let node = item.node else { return }
    Task {
      let ok = await Outbox.tested(node: node, works: works, note: note)
      guard ok else { return flash("grndwrk is not reachable. Try again when connected.") }
      stopTesting()
      flash(works ? "Approved. It is fixed in grndwrk." : "Rejected. It is back in grndwrk with your note.")
    }
  }

  /// Hiding is until the app is opened again: say so before it is gone.
  private func confirmHide() {
    let alert = UIAlertController(
      title: "Hide the grndwrk button?",
      message: "It stays hidden until the app is opened again: swipe it away in the app switcher and open it, and the button is back. Comments that wait stay on the phone, and no pictures are taken while it is hidden.",
      preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Hide", style: .destructive) { _ in GrndwrkFeedback.stop() })
    present(alert, animated: true)
  }

  /// A picture of the screen went to grndwrk: the camera on the button shows for a moment.
  private func blinkCamera() {
    view.bringSubviewToFront(button)
    UIView.animate(withDuration: 0.15) { self.camera.alpha = 1 } completion: { _ in
      UIView.animate(withDuration: 0.4, delay: 1.4) { self.camera.alpha = 0 }
    }
  }

  /// One file with every waiting comment, pictures included. The person who
  /// runs grndwrk adds it with `grndwrk import-feedback <file>`.
  func share(from presenter: UIViewController? = nil) {
    guard let (file, sent) = Outbox.export() else { return }
    let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
    activity.popoverPresentationController?.sourceView = presenter?.view ?? button
    activity.completionWithItemsHandler = { [weak self] _, completed, _, _ in
      guard completed else { return }
      // Shared: they are on their way, so they do not wait here any more.
      Outbox.remove(sent)
      self?.flash("Shared. They will show up in grndwrk once imported.")
    }
    (presenter ?? self).present(activity, animated: true)
  }

  // MARK: Picking

  @objc func togglePicking() {
    setPicking(!picking)
  }

  private func setPicking(_ on: Bool) {
    picking = on
    defer { updateTestPill() }
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
      custom = nil
      placeHandles(hidden: true)
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
    custom = nil
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

    let light = UIColor(white: 0.91, alpha: 1)
    /// A control at least 44 points high, as iOS asks for anything a finger taps.
    func control(_ name: String, _ title: String?, _ label: String, _ action: @escaping () -> Void) -> UIButton {
      var c = UIButton.Configuration.plain()
      c.image = UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
      c.title = title
      c.imagePadding = 6
      c.baseForegroundColor = light
      c.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10)
      let b = UIButton(configuration: c)
      b.accessibilityLabel = label
      b.addAction(UIAction { _ in action() }, for: .touchUpInside)
      b.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
      b.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
      return b
    }
    let close = control("xmark", nil, "Stop picking") { [weak self] in self?.setPicking(false) }
    smaller = control("arrow.down.right.and.arrow.up.left", "Smaller", "Smaller") { [weak self] in self?.step(-1) }
    bigger = control("arrow.up.left.and.arrow.down.right", "Bigger", "Bigger") { [weak self] in self?.step(1) }

    // First row: what is picked, in full, and a way out.
    barLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    barLabel.textColor = light
    barLabel.numberOfLines = 2
    barLabel.lineBreakMode = .byTruncatingTail
    barLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let top = UIStackView(arrangedSubviews: [barLabel, close])
    top.alignment = .center
    top.spacing = 4

    // Second row: change the pick, then comment.
    var c = UIButton.Configuration.filled()
    c.title = "Comment"
    c.image = UIImage(systemName: "text.bubble")
    c.imagePadding = 6
    c.baseBackgroundColor = blue
    c.cornerStyle = .capsule
    c.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 18, bottom: 12, trailing: 18)
    let go = UIButton(configuration: c)
    go.setContentCompressionResistancePriority(.required, for: .horizontal)
    go.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    go.addAction(UIAction { [weak self] _ in self?.compose() }, for: .touchUpInside)
    let actions = UIStackView(arrangedSubviews: [smaller, bigger, UIView(), go])
    actions.alignment = .center
    actions.spacing = 4

    let stack = UIStackView(arrangedSubviews: [top, actions])
    stack.axis = .vertical
    stack.spacing = 6
    stack.translatesAutoresizingMaskIntoConstraints = false
    bar.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 14),
      stack.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -8),
      stack.topAnchor.constraint(equalTo: bar.topAnchor, constant: 8),
      stack.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -10),
    ])
    bar.layer.cornerRadius = 20
    view.addSubview(bar)
  }

  func step(_ by: Int) {
    // From a framed area, the arrows go back to the picks under the finger.
    if custom != nil {
      custom = nil
    } else {
      chosen = max(0, min(candidates.count - 1, chosen + by))
    }
    showChosen()
  }

  private func showChosen() {
    guard let found = picked else { return }
    UIView.animate(withDuration: 0.15) {
      self.highlight.frame = found.frame.insetBy(dx: -3, dy: -3)
      self.placeHandles(hidden: false)
    }
    highlight.isHidden = false
    // Two lines to show it: cut at a word, never in the middle of a " · ".
    let words = found.label.map { String($0.prefix(90)).replacingOccurrences(of: #"\s*·\s*$"#, with: "", options: .regularExpression) }
    barLabel.text = custom != nil ? "Your area" + (words.map { " \u{201C}\($0)\u{201D}" } ?? "") : found.describe()
    smaller.isEnabled = custom != nil || chosen > 0
    bigger.isEnabled = custom != nil || chosen < candidates.count - 1
    // The bar sits at the top or the bottom, away from what is picked.
    let width = view.bounds.width - 24
    // Two rows: what is picked, then the actions, each at least 44 points.
    let height = bar.systemLayoutSizeFitting(CGSize(width: view.bounds.width - 24, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height
    let safe = view.safeAreaInsets
    let below = found.frame.midY < view.bounds.midY
    let y = below ? view.bounds.height - safe.bottom - height - 12 : safe.top + 8
    bar.frame = CGRect(x: 12, y: y, width: width, height: height)
    bar.isHidden = false
    view.bringSubviewToFront(bar)
  }

  // MARK: Framing an area by hand

  private func placeHandles(hidden: Bool) {
    let box = highlight.frame
    let corners = [CGPoint(x: box.minX, y: box.minY), CGPoint(x: box.maxX, y: box.minY), CGPoint(x: box.minX, y: box.maxY), CGPoint(x: box.maxX, y: box.maxY)]
    for (handle, at) in zip(handles, corners) {
      handle.center = at
      handle.isHidden = hidden || !picking
      if !handle.isHidden { view.bringSubviewToFront(handle) }
    }
  }

  /// A corner dragged: the opposite corner stays where it is.
  @objc private func resizeBox(_ pan: UIPanGestureRecognizer) {
    guard let handle = pan.view else { return }
    if pan.state == .began { dragStart = highlight.frame }
    let move = pan.translation(in: view)
    var minX = dragStart.minX, minY = dragStart.minY, maxX = dragStart.maxX, maxY = dragStart.maxY
    let smallest: CGFloat = 28
    if handle.tag % 2 == 0 { minX = min(dragStart.minX + move.x, maxX - smallest) } else { maxX = max(dragStart.maxX + move.x, minX + smallest) }
    if handle.tag < 2 { minY = min(dragStart.minY + move.y, maxY - smallest) } else { maxY = max(dragStart.maxY + move.y, minY + smallest) }
    let box = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY).intersection(view.bounds)
    framed(box, done: pan.state == .ended || pan.state == .cancelled)
  }

  /// The inside of the box dragged: the box moves as it is.
  @objc private func moveBox(_ pan: UIPanGestureRecognizer) {
    guard picking else { return }
    if pan.state == .began { dragStart = highlight.frame }
    let move = pan.translation(in: view)
    var box = dragStart.offsetBy(dx: move.x, dy: move.y)
    box.origin.x = max(view.bounds.minX, min(box.origin.x, view.bounds.maxX - box.width))
    box.origin.y = max(view.bounds.minY, min(box.origin.y, view.bounds.maxY - box.height))
    framed(box, done: pan.state == .ended || pan.state == .cancelled)
  }

  func framed(_ box: CGRect, done: Bool) {
    highlight.frame = box
    placeHandles(hidden: false)
    guard done, let window = appWindow() else { return }
    // What the area holds, read once the finger lets go.
    custom = Inspector.area(box.insetBy(dx: 3, dy: 3), in: window)
    showChosen()
  }

  /// Ask for the comment on what is picked.
  func compose() {
    guard let found = picked, let window = appWindow() else { return }
    let screen = Inspector.screen(of: window)
    // The picture first, without the highlight in it.
    let image = Inspector.crop(window, around: found.frame)
    setPicking(false)
    custom = nil
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
      case .rejected(let status): return "grndwrk did not take it (\(status))."
      case .blockedByATS: return "Blocked by App Transport Security. See the GrndwrkFeedback README."
      case .unreachable: return "grndwrk is not reachable. Write it here instead, and it goes once it is."
      case .needsCode: return "grndwrk needs the pairing code first. Write it here instead, and it goes once paired."
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
      flash("Sent to grndwrk")
      await Outbox.flush()
    case .rejected(let status):
      flash("grndwrk did not take it (\(status))")
    case .blockedByATS:
      flash("Blocked by App Transport Security. See the GrndwrkFeedback README.")
    case .unreachable:
      Outbox.save(data)
      flash("Saved on the phone. It goes to grndwrk once connected (\(Outbox.count) waiting)")
    case .needsCode:
      Outbox.save(data)
      flash("Saved on the phone. It goes once you enter the pairing code (\(Outbox.count) waiting)")
    }
    updateBadge()
  }

  // MARK: Badge and messages

  /// "Comment · 2" while comments wait to be sent, "Offline · 2" while grndwrk
  /// cannot be reached, and the dot: green when connected, orange when not.
  func updateBadge() {
    var config = button.configuration
    // Offline, the button says so in words, so nobody wonders where comments went.
    let offline: Bool
    if case .offline = Connection.state { offline = true } else { offline = false }
    let name = offline ? "Offline" : "grndwrk"
    config?.title = Outbox.count > 0 ? "\(name) · \(Outbox.count)" : name
    config?.image = UIImage(systemName: offline ? "wifi.slash" : "text.bubble")
    config?.titleLineBreakMode = .byClipping
    config?.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16 + testRoom)
    button.configuration = config
    switch Connection.state {
    case .connected: dot.backgroundColor = .systemGreen
    case .needsCode: dot.backgroundColor = .systemYellow
    case .offline: dot.backgroundColor = .systemOrange
    case .unknown: dot.backgroundColor = .systemGray
    }
    button.accessibilityValue = status()
    // Grow or shrink to the left, keeping the button where the person put it.
    guard button.frame != .zero else { return }
    let size = minimumTap(button.intrinsicContentSize)
    button.frame = CGRect(x: button.frame.maxX - size.width, y: button.frame.minY, width: size.width, height: size.height)
    dot.frame.origin = CGPoint(x: button.bounds.width - 12, y: 1)
    camera.frame.origin = CGPoint(x: -4, y: -6)
    layoutTestPill()
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
/// At least 44 by 44 points: what iOS asks for anything a finger taps.
func minimumTap(_ size: CGSize) -> CGSize {
  CGSize(width: max(44, size.width), height: max(44, size.height))
}
#endif
