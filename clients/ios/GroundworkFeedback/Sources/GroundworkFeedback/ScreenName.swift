#if canImport(UIKit)
import UIKit

/// An invisible view that names the screen it sits on, for screens without a
/// navigation title. Put there by `.groundworkScreen("Connect")` in SwiftUI,
/// or added by hand in UIKit. It draws nothing, takes no touches and is not
/// read by VoiceOver.
public final class GroundworkScreenName: UIView {
  public var name: String

  public init(_ name: String) {
    self.name = name
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    backgroundColor = .clear
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}
#endif

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

extension View {
  /// Names this screen for Groundwork when it has no navigation title, so
  /// comments and pictures from it land on the right screen in the map. It
  /// changes nothing the person sees, and nothing VoiceOver or UI tests read.
  ///
  ///     ConnectView()
  ///       .groundworkScreen("Connect")
  public func groundworkScreen(_ name: String) -> some View {
    background(ScreenNameView(name: name).allowsHitTesting(false).accessibilityHidden(true))
  }
}

private struct ScreenNameView: UIViewRepresentable {
  let name: String
  func makeUIView(context: Context) -> GroundworkScreenName { GroundworkScreenName(name) }
  func updateUIView(_ view: GroundworkScreenName, context: Context) { view.name = name }
}
#endif
