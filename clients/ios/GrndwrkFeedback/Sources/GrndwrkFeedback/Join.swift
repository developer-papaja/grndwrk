#if canImport(UIKit)
import AVFoundation
import UIKit

/// Joining the team's relay with an invite from the map: the link pasted,
/// or its QR code scanned. Scanning needs the camera, which an app may only
/// use when its Info.plist says why (NSCameraUsageDescription); without
/// that, only pasting is offered.
extension OverlayController {
  static var canScan: Bool {
    Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") != nil && UIImagePickerController.isSourceTypeAvailable(.camera)
  }

  func joinRelay() {
    let copied = UIPasteboard.general.hasStrings ? UIPasteboard.general.string ?? "" : ""
    let alert = UIAlertController(
      title: "Join with an invite",
      message: "Paste the invite link from grndwrk\(Self.canScan ? ", or scan its QR code" : ""). Comments then go through your team's relay when grndwrk is not on this Wi-Fi.",
      preferredStyle: .alert)
    alert.addTextField {
      $0.placeholder = "grndwrk:invite/..."
      $0.text = Relay.parse(copied) != nil ? copied : ""
      $0.autocapitalizationType = .none
      $0.autocorrectionType = .no
    }
    alert.addAction(UIAlertAction(title: "Join", style: .default) { [weak self] _ in
      self?.join(alert.textFields?.first?.text ?? "")
    })
    if Self.canScan {
      alert.addAction(UIAlertAction(title: "Scan the QR code", style: .default) { [weak self] _ in self?.scanInvite() })
    }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    present(alert, animated: true)
  }

  func leaveRelay() {
    let alert = UIAlertController(title: "Leave the relay?", message: "Comments then go only to grndwrk on this Wi-Fi. Joining again needs a new invite.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Leave", style: .destructive) { [weak self] _ in
      Relay.leave()
      self?.flash("Left the relay")
    })
    present(alert, animated: true)
  }

  private func join(_ link: String) {
    Task {
      do {
        try await Relay.join(link)
        await Connection.check()
        showDigits()
      } catch Relay.Problem.notALink {
        flash("That is not an invite link from grndwrk")
      } catch Relay.Problem.expired {
        flash("That invite has expired or was withdrawn. Ask for a new one")
      } catch Relay.Problem.used {
        flash("That invite was used already. Ask for a new one")
      } catch Relay.Problem.unreachable {
        flash("The relay did not answer. Try again on a network with internet")
      } catch {
        flash("The relay did not take it. Ask for a new invite")
      }
    }
  }

  /// Whoever invited you allows this phone in their map, when it shows the same four digits.
  func showDigits() {
    guard let digits = Relay.joined?.digits else { return }
    let alert = UIAlertController(
      title: digits,
      message: "Tell whoever invited you these four digits. They allow this phone in grndwrk when their map shows the same. Until then, comments wait on the phone.",
      preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default))
    present(alert, animated: true)
  }

  private func scanInvite() {
    let scanner = InviteScanner { [weak self] link in
      self?.dismiss(animated: true) { self?.join(link) }
    }
    present(UINavigationController(rootViewController: scanner), animated: true)
  }
}

/// The camera, looking for a QR code that holds an invite link. Nothing else is read or kept.
final class InviteScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let session = AVCaptureSession()
  private let found: (String) -> Void
  private var done = false

  init(found: @escaping (String) -> Void) {
    self.found = found
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Scan the invite"
    view.backgroundColor = .black
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    AVCaptureDevice.requestAccess(for: .video) { [weak self] ok in
      DispatchQueue.main.async { ok ? self?.startCamera() : self?.say("grndwrk may not use the camera. Paste the link instead.") }
    }
  }

  private func startCamera() {
    guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
      return say("No camera here. Paste the link instead.")
    }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else { return say("The camera cannot read codes here.") }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.addSublayer(preview)
    DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
  }

  private func say(_ text: String) {
    let l = UILabel()
    l.text = text
    l.textColor = .white
    l.numberOfLines = 0
    l.textAlignment = .center
    l.frame = view.bounds.insetBy(dx: 24, dy: 0)
    l.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(l)
  }

  nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
    let text = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }.first
    MainActor.assumeIsolated {
      // Only an invite link: any other code is ignored, and scanning goes on.
      guard !done, let text, Relay.parse(text) != nil else { return }
      done = true
      session.stopRunning()
      found(text)
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if session.isRunning { session.stopRunning() }
  }
}
#endif
