#if canImport(UIKit)
import UIKit

/// Where the comment is written: typed or spoken here, or on the Mac.
@MainActor
final class ComposeController: UIViewController, UITextViewDelegate, UIAdaptivePresentationControllerDelegate {
  private let found: Inspector.Found
  private let screen: Inspector.Screen
  private let image: Data?
  /// Send the text. Done with the sheet either way.
  var onSend: (String) -> Void = { _ in }
  /// Open it on the Mac instead. Returns a reason when that did not work, and the sheet stays.
  var onMac: () async -> String? = { nil }
  var onClose: () -> Void = {}

  private let field = UITextView()
  private let placeholder = UILabel()
  private let mic = UIButton(type: .system)
  private let language = UIButton(type: .system)
  private let mac = UIButton(type: .system)
  private let note = UILabel()
  private let dictation = Dictation()
  /// The text before speaking started; what is heard goes after it.
  private var spokenAfter = ""

  init(found: Inspector.Found, screen: Inspector.Screen, image: Data?) {
    self.found = found
    self.screen = screen
    self.image = image
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    title = "Comment"
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.close() })
    navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Send", primaryAction: UIAction { [weak self] _ in self?.send() })
    navigationItem.rightBarButtonItem?.style = .done
    navigationItem.rightBarButtonItem?.isEnabled = false

    // What the comment is about, with the picture of it.
    let thumb = UIImageView(image: image.flatMap { UIImage(data: $0) })
    thumb.contentMode = .scaleAspectFit
    thumb.layer.cornerRadius = 6
    thumb.clipsToBounds = true
    thumb.backgroundColor = .secondarySystemBackground
    thumb.isHidden = image == nil
    thumb.widthAnchor.constraint(equalToConstant: 64).isActive = true
    thumb.heightAnchor.constraint(equalToConstant: 48).isActive = true
    let about = UILabel()
    about.numberOfLines = 2
    about.font = .preferredFont(forTextStyle: .footnote)
    about.textColor = .secondaryLabel
    about.text = "On \(found.describe())\nin \(screen.name)"
    let context = UIStackView(arrangedSubviews: [thumb, about])
    context.spacing = 10
    context.alignment = .center

    field.font = .preferredFont(forTextStyle: .body)
    field.backgroundColor = .secondarySystemBackground
    field.layer.cornerRadius = 10
    field.textContainerInset = UIEdgeInsets(top: 10, left: 6, bottom: 10, right: 6)
    field.delegate = self
    field.heightAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
    placeholder.text = "What should change?"
    placeholder.font = field.font
    placeholder.textColor = .placeholderText
    placeholder.translatesAutoresizingMaskIntoConstraints = false
    field.addSubview(placeholder)
    NSLayoutConstraint.activate([
      placeholder.leadingAnchor.constraint(equalTo: field.leadingAnchor, constant: 11),
      placeholder.topAnchor.constraint(equalTo: field.topAnchor, constant: 10),
    ])

    var micConfig = UIButton.Configuration.tinted()
    micConfig.image = UIImage(systemName: "mic.fill")
    micConfig.title = "Speak"
    micConfig.imagePadding = 6
    micConfig.cornerStyle = .capsule
    mic.configuration = micConfig
    mic.addAction(UIAction { [weak self] _ in self?.toggleSpeaking() }, for: .touchUpInside)

    // Which language to listen for, when the person has more than one.
    let languages = Dictation.languages
    var langConfig = UIButton.Configuration.plain()
    langConfig.title = short(Dictation.language)
    langConfig.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
    language.configuration = langConfig
    language.showsMenuAsPrimaryAction = true
    language.menu = UIMenu(title: "Listen for", children: languages.map { locale in
      UIAction(title: Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier, state: locale.identifier == Dictation.language.identifier ? .on : .off) { [weak self] _ in
        Dictation.language = locale
        self?.language.configuration?.title = self?.short(locale)
      }
    })
    language.isHidden = languages.count < 2

    var macConfig = UIButton.Configuration.plain()
    macConfig.image = UIImage(systemName: "laptopcomputer")
    macConfig.title = "Write on the Mac"
    macConfig.imagePadding = 6
    macConfig.titleLineBreakMode = .byTruncatingTail
    mac.configuration = macConfig
    mac.setContentCompressionResistancePriority(.required, for: .horizontal)
    mic.setContentCompressionResistancePriority(.required, for: .horizontal)
    mac.addAction(UIAction { [weak self] _ in self?.writeOnMac() }, for: .touchUpInside)
    mac.isHidden = Connection.project == nil

    let space = UIView()
    space.setContentHuggingPriority(.defaultLow, for: .horizontal)
    space.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let tools = UIStackView(arrangedSubviews: [mic, language, space, mac])
    tools.spacing = 4
    tools.alignment = .center

    note.font = .preferredFont(forTextStyle: .footnote)
    note.textColor = .secondaryLabel
    note.numberOfLines = 0
    note.isHidden = true

    let stack = UIStackView(arrangedSubviews: [context, field, tools, note])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    navigationController?.presentationController?.delegate = self
    field.becomeFirstResponder()
  }

  private func short(_ locale: Locale) -> String {
    String(locale.identifier.prefix(2)).uppercased()
  }

  func textViewDidChange(_ textView: UITextView) {
    changed()
  }

  private func changed() {
    let empty = field.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    placeholder.isHidden = !field.text.isEmpty
    navigationItem.rightBarButtonItem?.isEnabled = !empty
    mac.isHidden = !empty || Connection.project == nil
  }

  private func say(_ text: String?) {
    note.text = text
    note.isHidden = text == nil
  }

  // MARK: Speaking

  private func toggleSpeaking() {
    if dictation.running { return stopSpeaking() }
    guard Dictation.allowed else {
      return say("To speak comments, add NSMicrophoneUsageDescription and NSSpeechRecognitionUsageDescription to the app's debug Info.plist. The keyboard's own mic works meanwhile.")
    }
    let before = field.text.trimmingCharacters(in: .whitespacesAndNewlines)
    spokenAfter = before.isEmpty ? "" : before + " "
    setSpeaking(true)
    say("Listening in \(Locale.current.localizedString(forIdentifier: Dictation.language.identifier) ?? Dictation.language.identifier). Tap Stop when done.")
    Task { [weak self] in
      await self?.dictation.start(heard: { [weak self] text in
        guard let self else { return }
        self.field.text = self.spokenAfter + text
        self.changed()
      }, ended: { [weak self] reason in
        self?.setSpeaking(false)
        self?.say(reason)
      })
    }
  }

  private func stopSpeaking() {
    dictation.stop()
    setSpeaking(false)
    say(nil)
  }

  private func setSpeaking(_ on: Bool) {
    var config = mic.configuration
    config?.image = UIImage(systemName: on ? "stop.fill" : "mic.fill")
    config?.title = on ? "Stop" : "Speak"
    config?.baseForegroundColor = on ? .systemRed : nil
    config?.baseBackgroundColor = on ? .systemRed : nil
    mic.configuration = config
    if on { field.resignFirstResponder() }
  }

  // MARK: Done

  private func send() {
    stopSpeaking()
    let text = field.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    dismiss(animated: true)
    onSend(text)
    onClose()
  }

  private func writeOnMac() {
    stopSpeaking()
    mac.isEnabled = false
    say("Opening it on the Mac...")
    Task {
      if let problem = await onMac() {
        mac.isEnabled = true
        say(problem)
        return
      }
      dismiss(animated: true)
      onClose()
    }
  }

  private func close() {
    stopSpeaking()
    dismiss(animated: true)
    onClose()
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    dictation.stop()
    onClose()
  }
}
#endif
