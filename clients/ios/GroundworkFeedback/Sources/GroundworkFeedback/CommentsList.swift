#if canImport(UIKit)
import UIKit

/// The connection, the comments waiting to be sent (send now, share or
/// delete), and the ones sent, as they are in Groundwork now. Deleting a sent
/// comment deletes it in Groundwork too. Pull down to check again.
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

  private enum Section: Int, CaseIterable { case connection, waiting, sent }

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
    refreshControl = UIRefreshControl()
    refreshControl?.addAction(UIAction { [weak self] _ in self?.refresh() }, for: .valueChanged)
    for name in [Connection.changed, Outbox.changed] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.reload() }
      }
    }
    reload()
    refresh()
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

  /// A short message above the title. The Comment button's messages would sit behind this sheet.
  private func say(_ text: String) {
    navigationItem.prompt = text
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
      if self?.navigationItem.prompt == text { self?.navigationItem.prompt = nil }
    }
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
          if !Outbox.waiting.isEmpty { self?.say("Groundwork is not reachable yet") }
        }
      })
      actions.append(UIAction(title: "Share as a file", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
        self?.overlay?.share(from: self)
      })
    }
    navigationItem.rightBarButtonItem = actions.isEmpty ? nil : UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: actions))
    tableView.reloadData()
  }

  override func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

  override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
    switch Section(rawValue: section)! {
    case .connection: return nil
    case .waiting: return "Waiting to be sent (\(waiting.count))"
    case .sent: return "Sent to Groundwork (\(sent.count))"
    }
  }

  override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
    switch Section(rawValue: section)! {
    case .connection:
      if case .offline = Connection.state {
        return "Is Groundwork running with --lan, on the same Wi-Fi? Comments are kept on the phone until it is. Pull down to check again."
      }
      return nil
    case .waiting:
      return waiting.isEmpty ? nil : "They go by themselves once Groundwork is reachable. Or share them as a file."
    case .sent:
      return sent.isEmpty ? "Nothing sent yet." : "In Groundwork they are on the Feedback page, in a topic per screen. Deleting one here deletes it there too."
    }
  }

  override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    switch Section(rawValue: section)! {
    case .connection: return 1
    case .waiting: return waiting.count
    case .sent: return sent.count
    }
  }

  override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
    cell.selectionStyle = .none
    var content = UIListContentConfiguration.subtitleCell()
    content.secondaryTextProperties.color = .secondaryLabel
    if indexPath.section == Section.connection.rawValue {
      let (color, text): (UIColor, String) = {
        switch Connection.state {
        case .connected: return (.systemGreen, "Connected")
        case .offline: return (.systemOrange, "Not connected")
        case .unknown: return (.systemGray, "Looking for Groundwork")
        }
      }()
      content.image = UIImage(systemName: "circle.fill")
      content.imageProperties.tintColor = color
      content.imageProperties.maximumSize = CGSize(width: 12, height: 12)
      content.text = text
      switch Connection.state {
      case .connected(let project, let host): content.secondaryText = "\(project.isEmpty ? "Groundwork" : "\u{201C}\(project)\u{201D}") at \(host)"
      case .offline: content.secondaryText = "Comments wait on the phone"
      case .unknown: content.secondaryText = nil
      }
      cell.contentConfiguration = content
      return cell
    }
    let item = indexPath.section == Section.waiting.rawValue ? waiting[indexPath.row] : sent[indexPath.row]
    content.text = item.text
    content.secondaryText = [item.detail, item.written.map { dates.string(from: $0) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    cell.contentConfiguration = content
    return cell
  }

  override func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    switch Section(rawValue: indexPath.section)! {
    case .connection:
      return nil
    case .waiting:
      guard let file = waiting[indexPath.row].file else { return nil }
      return UISwipeActionsConfiguration(actions: [UIContextualAction(style: .destructive, title: "Delete") { [weak self] _, _, done in
        Outbox.remove([file])
        self?.reload()
        done(true)
      }])
    case .sent:
      guard let node = sent[indexPath.row].node, !node.isEmpty else { return nil }
      return UISwipeActionsConfiguration(actions: [UIContextualAction(style: .destructive, title: "Delete") { [weak self] _, _, done in
        Task {
          switch await Outbox.deleteSent(node: node) {
          case .everywhere: self?.say("Deleted here and in Groundwork")
          case .later: self?.say("Deleted here. Groundwork deletes it once connected.")
          case .onlyHere: self?.say("Sent before deleting was possible. Delete \(node) in Groundwork.")
          }
          self?.reload()
          done(true)
        }
      }])
    }
  }
}
#endif
