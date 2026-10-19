#if canImport(UIKit)
import UIKit

/// The comments on the phone. First an overview: the connection, and how
/// many fixes wait to be tested, how many comments wait to be sent, and how
/// many were sent. Each opens its own list, and each comment its own page.
/// Pull down to check again.
@MainActor
final class CommentsController: UITableViewController {
  enum Mode: Equatable { case overview, toTest, waiting, sent }

  private weak var overlay: OverlayController?
  private let mode: Mode
  private var items: [Outbox.Item] = []
  private let dates: DateFormatter = {
    let f = DateFormatter()
    f.dateStyle = .short
    f.timeStyle = .short
    return f
  }()

  init(overlay: OverlayController, mode: Mode) {
    self.overlay = overlay
    self.mode = mode
    super.init(style: .insetGrouped)
  }
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = ["Comments", "Ready to test", "Waiting to be sent", "Sent to grndwrk"][[Mode.overview, .toTest, .waiting, .sent].firstIndex(of: mode)!]
    tableView.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    if mode == .overview {
      navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    }
    refreshControl = UIRefreshControl()
    refreshControl?.addAction(UIAction { [weak self] _ in self?.refresh() }, for: .valueChanged)
    for name in [Connection.changed, Outbox.changed] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.reload() }
      }
    }
    reload()
    if mode == .overview { refresh() }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    reload()
  }

  /// Check the connection, send what waits, and ask what became of the sent ones.
  private func refresh() {
    Task {
      await Connection.check()
      await Outbox.flush()
      await Outbox.sync()
      reload()
      refreshControl?.endRefreshing()
    }
  }

  /// A short message above the title. The grndwrk button's messages would sit behind this sheet.
  func say(_ text: String) {
    navigationItem.prompt = text
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
      if self?.navigationItem.prompt == text { self?.navigationItem.prompt = nil }
    }
  }

  func reload() {
    switch mode {
    case .overview: items = []
    case .toTest: items = Outbox.toTest
    case .waiting: items = Outbox.waiting
    case .sent: items = Outbox.sent.filter { $0.state != "ready" }
    }
    var actions: [UIMenuElement] = []
    if mode != .sent, mode != .toTest, Outbox.count > 0 {
      actions.append(UIAction(title: "Send now", image: UIImage(systemName: "paperplane")) { [weak self] _ in
        Task {
          await Outbox.flush()
          self?.reload()
          if Outbox.count > 0 { self?.say("grndwrk is not reachable yet") }
        }
      })
      actions.append(UIAction(title: "Share as a file", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
        self?.overlay?.share(from: self)
      })
    }
    navigationItem.rightBarButtonItem = actions.isEmpty ? nil : UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: actions))
    tableView.reloadData()
  }

  // MARK: Overview

  /// The overview's rows: the connection, then one row per list.
  private var lists: [(mode: Mode, title: String, count: Int, icon: String, color: UIColor)] {
    [
      (.toTest, "Ready to test", Outbox.toTest.count, "checkmark.seal", .systemBlue),
      (.waiting, "Waiting to be sent", Outbox.count, "tray.and.arrow.up", .systemOrange),
      (.sent, "Sent to grndwrk", Outbox.sent.filter { $0.state != "ready" }.count, "paperplane", .systemGray),
    ]
  }

  override func numberOfSections(in tableView: UITableView) -> Int { mode == .overview ? 2 : 1 }

  override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    mode == .overview ? (section == 0 ? 1 : lists.count) : items.count
  }

  override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
    switch mode {
    case .overview:
      if section == 0, case .needsCode = Connection.state {
        return "Tap to pair: allow this phone in grndwrk on the Mac, or enter the code it shows in the terminal. Comments are kept on the phone until then."
      }
      if section == 0, case .offline(let why) = Connection.state {
        return "\(why)\n\nComments are kept on the phone until grndwrk answers. Pull down to check again."
      }
      return section == 1 ? "Ready to test: comments of yours whose fix your agent has built. Tap Test on one: it shows what to do, over the app, with Approve and Reject." : nil
    case .toTest: return items.isEmpty ? "Nothing to test right now. A fix shows up here once it is built." : "Test opens the app where it can be tested, with the steps on top. Tap a row to read more first."
    case .waiting: return items.isEmpty ? "Nothing waits." : "They go by themselves once grndwrk is reachable. Or share them as a file."
    case .sent: return items.isEmpty ? "Nothing sent yet." : "In grndwrk they are on the Feedback page, in a topic per screen. Deleting one here deletes it there too."
    }
  }

  override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    var content = UIListContentConfiguration.subtitleCell()
    content.secondaryTextProperties.color = .secondaryLabel
    cell.accessoryType = .none
    cell.selectionStyle = .default
    if mode == .overview, indexPath.section == 0 {
      let (color, text): (UIColor, String) = {
        switch Connection.state {
        case .connected: return (.systemGreen, "Connected")
        case .needsCode: return (.systemYellow, "Needs the pairing code")
        case .offline: return (.systemOrange, "Not connected")
        case .unknown: return (.systemGray, "Looking for grndwrk")
        }
      }()
      content.image = UIImage(systemName: "circle.fill")
      content.imageProperties.tintColor = color
      content.imageProperties.maximumSize = CGSize(width: 12, height: 12)
      content.text = text
      switch Connection.state {
      case .connected(let project, let host), .needsCode(let project, let host): content.secondaryText = "\(project.isEmpty ? "grndwrk" : "\u{201C}\(project)\u{201D}") at \(host)"
      case .offline: content.secondaryText = "Comments wait on the phone"
      case .unknown: content.secondaryText = nil
      }
      if case .needsCode = Connection.state {} else { cell.selectionStyle = .none }
      cell.contentConfiguration = content
      return cell
    }
    if mode == .overview {
      let list = lists[indexPath.row]
      content = UIListContentConfiguration.valueCell()
      content.image = UIImage(systemName: list.icon)
      content.imageProperties.tintColor = list.color
      content.text = list.title
      content.secondaryText = "\(list.count)"
      if list.mode == .toTest, list.count > 0 {
        content.textProperties.font = .preferredFont(forTextStyle: .headline)
        content.secondaryTextProperties.color = .systemBlue
      }
      cell.accessoryType = .disclosureIndicator
      cell.contentConfiguration = content
      return cell
    }
    let item = items[indexPath.row]
    content.text = item.text
    if mode == .toTest, let fix = item.fix, !fix.isEmpty {
      content.secondaryText = [item.screen.map { "On \($0)" }, fix].compactMap { $0 }.joined(separator: "\n")
      content.secondaryTextProperties.numberOfLines = 3
    } else {
      content.secondaryText = [item.detail, item.written.map { dates.string(from: $0) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    if let image = item.node.flatMap(Outbox.picture(node:)) ?? item.file.flatMap(Outbox.picture(file:)) {
      content.image = image
      content.imageProperties.maximumSize = CGSize(width: 44, height: 44)
      content.imageProperties.cornerRadius = 6
    }
    cell.accessoryType = .disclosureIndicator
    cell.accessoryView = nil
    if mode == .toTest {
      var c = UIButton.Configuration.filled()
      c.title = "Test"
      c.cornerStyle = .capsule
      c.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
      let test = UIButton(configuration: c, primaryAction: UIAction { [weak self] _ in self?.overlay?.startTesting(item) })
      test.sizeToFit()
      test.frame.size.height = max(44, test.frame.height)
      cell.accessoryView = test
    }
    cell.contentConfiguration = content
    return cell
  }

  override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    guard let overlay else { return }
    if mode == .overview {
      if indexPath.section == 0 {
        if case .needsCode = Connection.state { overlay.pair() }
        return
      }
      navigationController?.pushViewController(CommentsController(overlay: overlay, mode: lists[indexPath.row].mode), animated: true)
      return
    }
    navigationController?.pushViewController(CommentController(item: items[indexPath.row], overlay: overlay), animated: true)
  }

  override func tableView(_ tableView: UITableView, leadingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard mode == .toTest, let node = items[indexPath.row].node else { return nil }
    let fixed = UIContextualAction(style: .normal, title: "Approve") { [weak self] _, _, done in
      Task {
        let ok = await Outbox.tested(node: node, works: true)
        self?.say(ok ? "Approved, fixed in grndwrk" : "grndwrk is not reachable. Try again when connected.")
        self?.reload()
        done(ok)
      }
    }
    fixed.backgroundColor = .systemGreen
    return UISwipeActionsConfiguration(actions: [fixed])
  }

  override func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard mode == .waiting || mode == .sent else { return nil }
    let item = items[indexPath.row]
    return UISwipeActionsConfiguration(actions: [UIContextualAction(style: .destructive, title: "Delete") { [weak self] _, _, done in
      Task {
        let words = await CommentController.delete(item)
        if let words { self?.say(words) }
        self?.reload()
        done(true)
      }
    }])
  }
}

/// One comment: its picture, where it was made, what Claude changed, and
/// what can be done with it here.
@MainActor
final class CommentController: UIViewController {
  private var item: Outbox.Item
  private weak var overlay: OverlayController?
  private let stack = UIStackView()

  init(item: Outbox.Item, overlay: OverlayController) {
    self.item = item
    self.overlay = overlay
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemGroupedBackground
    title = item.state == "ready" ? "Ready to test" : "Comment"
    let scroll = UIScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll)
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -20),
    ])
    build()
  }

  private func build() {
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    if let image = item.node.flatMap(Outbox.picture(node:)) ?? item.file.flatMap(Outbox.picture(file:)) {
      let picture = UIImageView(image: image)
      picture.contentMode = .scaleAspectFit
      picture.layer.cornerRadius = 10
      picture.clipsToBounds = true
      picture.heightAnchor.constraint(lessThanOrEqualToConstant: 260).isActive = true
      picture.heightAnchor.constraint(equalTo: picture.widthAnchor, multiplier: min(1.2, image.size.height / max(image.size.width, 1))).isActive = true
      stack.addArrangedSubview(picture)
    }
    stack.addArrangedSubview(label(item.text, .title3, .label))
    // The detail starts with the screen: "Desks · text “Desk 1” · fix proposed · n_1m3f".
    stack.addArrangedSubview(label(item.detail.isEmpty ? "" : "Made on \(item.detail)", .footnote, .secondaryLabel))

    if let fix = item.fix, !fix.isEmpty, item.state != "incoming" {
      stack.addArrangedSubview(box(item.state == "proposed" ? "Proposed, not built yet" : "What changed", fix))
    }
    if let test = item.test, !test.isEmpty, item.state == "ready" {
      stack.addArrangedSubview(box("How to test it", test))
    }
    if item.node != nil {
      if item.state == "ready", let overlay {
        stack.addArrangedSubview(button("Test it in the app", "play.circle.fill", .systemBlue, filled: true) { overlay.startTesting(self.item) })
        stack.addArrangedSubview(button("Approve: it works", "checkmark.circle", .systemGreen) { [weak self] in self?.tested(works: true) })
        stack.addArrangedSubview(button("Reject", "xmark.circle", .systemRed) { [weak self] in self?.reject() })
      } else if item.state == "fixed" {
        stack.addArrangedSubview(button("Reopen: it is not fixed", "arrow.uturn.backward.circle", .systemRed) { [weak self] in self?.reject() })
      }
      stack.addArrangedSubview(button("Show on my Mac", "desktopcomputer", .systemBlue) { [weak self] in
        guard let self, let node = self.item.node else { return }
        Task {
          let ok = await Outbox.showOnMac(node: node)
          self.say(ok ? "Open on your Mac, with what changed in its thread" : "grndwrk is not reachable. Try again when connected.")
        }
      })
    }
    stack.addArrangedSubview(button("Delete", "trash", .systemRed) { [weak self] in
      guard let self else { return }
      Task {
        if let words = await CommentController.delete(self.item) { (self.navigationController?.viewControllers.dropLast().last as? CommentsController)?.say(words) }
        self.navigationController?.popViewController(animated: true)
      }
    })
  }

  private func say(_ text: String) {
    navigationItem.prompt = text
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
      if self?.navigationItem.prompt == text { self?.navigationItem.prompt = nil }
    }
  }

  private func label(_ text: String, _ style: UIFont.TextStyle, _ color: UIColor) -> UILabel {
    let l = UILabel()
    l.text = text
    l.font = .preferredFont(forTextStyle: style)
    l.textColor = color
    l.numberOfLines = 0
    return l
  }

  private func button(_ title: String, _ icon: String, _ color: UIColor, filled: Bool = false, action: @escaping () -> Void) -> UIButton {
    var c: UIButton.Configuration = filled ? .filled() : .tinted()
    c.title = title
    c.image = UIImage(systemName: icon)
    c.imagePadding = 8
    c.baseBackgroundColor = color
    c.baseForegroundColor = filled ? .white : color
    c.cornerStyle = .large
    c.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)
    let b = UIButton(configuration: c, primaryAction: UIAction { _ in action() })
    b.contentHorizontalAlignment = .leading
    return b
  }

  private func box(_ title: String, _ text: String) -> UIView {
    let box = UIStackView(arrangedSubviews: [label(title, .caption1, .secondaryLabel), label(text, .body, .label)])
    box.axis = .vertical
    box.spacing = 4
    box.isLayoutMarginsRelativeArrangement = true
    box.layoutMargins = UIEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
    box.backgroundColor = .secondarySystemGroupedBackground
    box.layer.cornerRadius = 10
    return box
  }

  private func reject() {
    let alert = UIAlertController(title: "Reject", message: "What is still wrong? It goes back to grndwrk with the comment, for the next /feedback.", preferredStyle: .alert)
    alert.addTextField { $0.placeholder = "Optional" }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Send", style: .default) { [weak self] _ in
      self?.tested(works: false, note: alert.textFields?.first?.text ?? "")
    })
    present(alert, animated: true)
  }

  private func tested(works: Bool, note: String = "") {
    guard let node = item.node else { return }
    Task {
      let ok = await Outbox.tested(node: node, works: works, note: note)
      guard ok else { return say("grndwrk is not reachable. Try again when connected.") }
      if let updated = Outbox.sent.first(where: { $0.node == node }) { item = updated }
      say(works ? "Approved, fixed in grndwrk" : "Rejected, back in grndwrk")
      build()
    }
  }

  /// Delete a waiting or sent comment. Returns what happened, in words, or nil.
  static func delete(_ item: Outbox.Item) async -> String? {
    if let file = item.file {
      Outbox.remove([file])
      return nil
    }
    guard let node = item.node, !node.isEmpty else { return nil }
    switch await Outbox.deleteSent(node: node) {
    case .everywhere: return "Deleted here and in grndwrk"
    case .later: return "Deleted here. grndwrk deletes it once connected."
    case .onlyHere: return "Sent before deleting was possible. Delete \(node) in grndwrk."
    }
  }
}
#endif
