#if canImport(UIKit)
import Darwin
import UIKit

/// Finds what was tapped: the elements VoiceOver knows, and the boxes the eye
/// sees (cards, rows, backgrounds), from the smallest to the largest.
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
    /// The navigation title when there is one, the name given with
    /// `.groundworkScreen`, or the view controller's or SwiftUI view's name.
    var name: String
    /// The view type, like BookingView, when it can be read.
    var component: String?
    /// Whether the name is the screen's own: a title, or `.groundworkScreen`.
    /// Without one, screens that look nothing alike can share a name like App.
    var named: Bool
  }

  /// How many elements VoiceOver knows on screen, from the last search. None
  /// at all means iOS has not built the accessibility tree yet.
  private(set) static var elementCount = 0

  /// On a device, iOS builds the accessibility tree only while something
  /// asks for it, like VoiceOver or a UI test. Ask the way UI test tools do,
  /// for as long as the app is in front. Debug builds only, like the rest of
  /// this package. Returns false when it cannot.
  static func wakeAccessibility() -> Bool {
    // A private switch: in Debug builds only, so it is not even in other builds.
    #if !DEBUG
    return false
    #else
    guard setAutomation == nil, let lib = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
      let set = dlsym(lib, "_AXSSetAutomationEnabled"), let get = dlsym(lib, "_AXSAutomationEnabled") else { return false }
    guard unsafeBitCast(get, to: Getter.self)() == 0 else { return false }
    let setter = unsafeBitCast(set, to: Setter.self)
    setAutomation = setter
    setter(1)
    // Put it back when the app leaves the front, so the phone is as it was.
    NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated {
        setAutomation?(0)
        setAutomation = nil
      }
    }
    return true
    #endif
  }
  private typealias Setter = @convention(c) (Int32) -> Void
  private typealias Getter = @convention(c) () -> Int32
  private static var setAutomation: Setter?

  /// The smallest accessibility element under the point. For the self test.
  static func element(at point: CGPoint, in window: UIWindow) -> Found {
    let list = candidates(at: point, in: window)
    return list[preferred(list)]
  }

  /// Which candidate to start from: the smallest element VoiceOver would read.
  static func preferred(_ list: [Found]) -> Int {
    list.firstIndex { $0.role != "area" } ?? 0
  }

  /// Everything under the point, from the smallest to the largest, so the
  /// person can step out from a label to its card, or back in. Never empty.
  static func candidates(at point: CGPoint, in window: UIWindow) -> [Found] {
    let screen = window.bounds.width * window.bounds.height
    let tooBig = { (r: CGRect) in r.width * r.height > screen * 0.85 }
    var elements: [(object: NSObject, frame: CGRect)] = []
    var boxes: [(frame: CGRect, identifier: String?)] = []

    // The accessibility tree: what VoiceOver reads, and the containers around it.
    var visited = 0
    func visit(_ object: NSObject, depth: Int) {
      visited += 1
      guard depth < 60, visited < 8000 else { return }
      if let view = object as? UIView, view.isHidden || view.alpha < 0.01 { return }
      let frame = object.accessibilityFrame
      if object.isAccessibilityElement, !frame.isEmpty {
        elements.append((object, frame))
      } else if !(object is UIWindow), frame.contains(point), !frame.isEmpty, !tooBig(frame) {
        boxes.append((frame, identifier(of: object)))
      }
      for child in children(of: object) { visit(child, depth: depth + 1) }
    }
    visit(window, depth: 0)
    elementCount = elements.count

    // The boxes the eye sees: SwiftUI draws cards and buttons as layers
    // with a background or rounded corners, not as views.
    var layers = 0
    func visitLayer(_ layer: CALayer, depth: Int) {
      layers += 1
      guard depth < 50, layers < 6000, !layer.isHidden, layer.opacity > 0.01 else { return }
      let frame = layer.convert(layer.bounds, to: window.layer)
      if frame.contains(point), !frame.isEmpty, !tooBig(frame) {
        let filled = (layer.backgroundColor?.alpha ?? 0) > 0.03
        if filled || layer.cornerRadius > 0 || layer.borderWidth > 0 || layer is CAShapeLayer { boxes.append((frame, nil)) }
      }
      for sub in layer.sublayers ?? [] { visitLayer(sub, depth: depth + 1) }
    }
    visitLayer(window.layer, depth: 0)

    // And the views under the finger, which in UIKit are the rows and cells.
    var view = window.hitTest(point, with: nil)
    while let v = view, v !== window {
      let frame = v.convert(v.bounds, to: window)
      if !tooBig(frame), !frame.isEmpty { boxes.append((frame, v.accessibilityIdentifier)) }
      view = v.superview
    }

    var under = elements.filter { $0.frame.contains(point) }
    // A tap between two words of a card: take the nearest element, if close.
    if under.isEmpty, let near = elements.map({ ($0, distance(point, $0.frame)) }).filter({ $0.1 < 24 }).min(by: { $0.1 < $1.1 }) {
      under = [near.0]
    }

    var list: [Found] = under.map { e in
      Found(frame: e.frame, label: clean(e.object.accessibilityLabel ?? e.object.accessibilityValue), identifier: identifier(of: e.object), role: role(of: e.object.accessibilityTraits))
    }
    for box in boxes {
      let texts = elements
        .filter { box.frame.insetBy(dx: -2, dy: -2).contains($0.frame) }
        .sorted { abs($0.frame.minY - $1.frame.minY) > 4 ? $0.frame.minY < $1.frame.minY : $0.frame.minX < $1.frame.minX }
        .compactMap { clean($0.object.accessibilityLabel) }
      var seen = Set<String>()
      let label = texts.filter { seen.insert($0).inserted }.prefix(4).joined(separator: " · ")
      list.append(Found(frame: box.frame, label: label.isEmpty ? nil : String(label.prefix(120)), identifier: box.identifier, role: "area"))
    }

    // Smallest first. Of two the same size, an element beats an area.
    list.sort { a, b in
      let sa = a.frame.width * a.frame.height, sb = b.frame.width * b.frame.height
      return abs(sa - sb) > 1 ? sa < sb : (a.role != "area" && b.role == "area")
    }
    var out: [Found] = []
    for f in list {
      if let i = out.firstIndex(where: { same($0.frame, f.frame) }) {
        // The same box seen twice: keep what says most about it.
        if out[i].identifier == nil { out[i].identifier = f.identifier }
        if out[i].label == nil { out[i].label = f.label }
        continue
      }
      out.append(f)
    }
    if out.isEmpty {
      out = [Found(frame: CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44), label: nil, identifier: nil, role: "spot")]
    }
    return out
  }

  private static func same(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 3 && abs(a.minY - b.minY) < 3 && abs(a.maxX - b.maxX) < 3 && abs(a.maxY - b.maxY) < 3
  }

  private static func distance(_ p: CGPoint, _ r: CGRect) -> CGFloat {
    let dx = max(r.minX - p.x, 0, p.x - r.maxX)
    let dy = max(r.minY - p.y, 0, p.y - r.maxY)
    return (dx * dx + dy * dy).squareRoot()
  }

  /// SwiftUI's elements carry .accessibilityIdentifier without declaring the protocol, so ask by name too.
  private static func identifier(of object: NSObject) -> String? {
    let id = (object as? UIAccessibilityIdentification)?.accessibilityIdentifier
      ?? (object.responds(to: Selector(("accessibilityIdentifier"))) ? object.value(forKey: "accessibilityIdentifier") as? String : nil)
    return clean(id)
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
      // SwiftUI's NavigationStack and TabView keep a navigation or tab controller as a child of the hosting controller.
      else if let child = vc?.children.last(where: { ($0 is UINavigationController || $0 is UITabBarController) && $0.isViewLoaded && $0.view.window != nil }) { vc = child }
      else { break }
    }
    let component = vc.flatMap { typeName(String(describing: type(of: $0))) }
    let title = clean(vc?.navigationItem.title ?? vc?.title)
    let given = title == nil ? givenName(in: vc?.viewIfLoaded ?? window) ?? givenName(in: window) : nil
    return Screen(name: title ?? given ?? component ?? "App", component: component, named: title != nil || given != nil)
  }

  /// The name from `.groundworkScreen("Connect")`: the frontmost one on screen.
  private static func givenName(in root: UIView) -> String? {
    var found: String?
    var visited = 0
    func visit(_ view: UIView) {
      visited += 1
      guard visited < 6000, !view.isHidden, view.alpha > 0.01 else { return }
      if let marker = view as? GroundworkScreenName, let window = view.window,
        view.convert(view.bounds, to: window).intersects(window.bounds), let name = clean(marker.name) {
        found = name
      }
      for sub in view.subviews { visit(sub) }
    }
    visit(root)
    return found
  }

  /// What the screen shows: the texts VoiceOver would read and the
  /// accessibility identifiers, top to bottom, without the tab bar, which
  /// every screen shares. Enough to tell two screens with the same name apart.
  static func contents(of window: UIWindow) -> (texts: [String], ids: [String]) {
    var found: [(text: String?, id: String?, frame: CGRect)] = []
    var visited = 0
    func visit(_ object: NSObject, depth: Int) {
      visited += 1
      guard depth < 60, visited < 8000 else { return }
      if let view = object as? UIView, view.isHidden || view.alpha < 0.01 || view is UITabBar { return }
      if object.accessibilityTraits.contains(.tabBar) { return }
      let frame = object.accessibilityFrame
      if !frame.isEmpty, frame.intersects(window.bounds) {
        let id = identifier(of: object)
        let text = object.isAccessibilityElement ? clean(object.accessibilityLabel) : nil
        if id != nil || text != nil { found.append((text, id, frame)) }
      }
      for child in children(of: object) { visit(child, depth: depth + 1) }
    }
    visit(window, depth: 0)
    found.sort { abs($0.frame.minY - $1.frame.minY) > 4 ? $0.frame.minY < $1.frame.minY : $0.frame.minX < $1.frame.minX }
    var seenText = Set<String>(), seenId = Set<String>()
    let texts = found.compactMap { $0.text.map { String($0.prefix(80)) } }.filter { seenText.insert($0).inserted }
    let ids = found.compactMap(\.id).filter { seenId.insert($0).inserted }
    return (Array(texts.prefix(60)), Array(ids.prefix(60)))
  }

  /// "UIHostingController<ModifiedContent<BookingView, ...>>" gives BookingView.
  static func typeName(_ raw: String) -> String? {
    let wrappers: Set<String> = ["UIHostingController", "ModifiedContent", "AnyView", "Optional", "TupleView", "NavigationStack", "NavigationView", "Group", "VStack", "HStack", "ZStack", "EmptyView", "Never", "Text"]
    let words = raw.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "_" }).map(String.init)
    // Only wrappers, like UIHostingController<AnyView>: the view's name cannot be read.
    return words.first(where: { !wrappers.contains($0) && !$0.hasPrefix("_") && $0.first?.isUppercase == true && !$0.hasSuffix("Modifier") && !$0.hasSuffix("HostingController") })
  }

  /// An area the person framed by hand: what VoiceOver reads inside it, top
  /// to bottom, and the first accessibility identifier there.
  static func area(_ frame: CGRect, in window: UIWindow) -> Found {
    var inside: [(text: String?, id: String?, frame: CGRect)] = []
    var visited = 0
    func visit(_ object: NSObject, depth: Int) {
      visited += 1
      guard depth < 60, visited < 8000 else { return }
      if let view = object as? UIView, view.isHidden || view.alpha < 0.01 { return }
      let f = object.accessibilityFrame
      if object.isAccessibilityElement, !f.isEmpty, frame.insetBy(dx: -2, dy: -2).contains(f) {
        inside.append((clean(object.accessibilityLabel), identifier(of: object), f))
      }
      for child in children(of: object) { visit(child, depth: depth + 1) }
    }
    visit(window, depth: 0)
    inside.sort { abs($0.frame.minY - $1.frame.minY) > 4 ? $0.frame.minY < $1.frame.minY : $0.frame.minX < $1.frame.minX }
    var seen = Set<String>()
    let label = inside.compactMap(\.text).filter { seen.insert($0).inserted }.prefix(4).joined(separator: " · ")
    return Found(frame: frame, label: label.isEmpty ? nil : String(label.prefix(120)), identifier: inside.compactMap(\.id).first, role: "area")
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
#endif
