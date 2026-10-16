#if canImport(UIKit)
import Foundation
import os

#if !DEBUG
#warning("GrndwrkFeedback is compiled into a build that is not Debug. It does nothing there unless start(allowOutsideDebug: true), and never in the App Store. Keep it out of App Store builds: see its README.")
#endif

/// Where this build came from, so the grndwrk button never reaches people
/// who downloaded the app.
enum Distribution {
  private static let log = Logger(subsystem: "GrndwrkFeedback", category: "distribution")

  /// From the App Store: a production receipt and no provisioning profile.
  /// TestFlight builds have a sandbox receipt; development and Ad Hoc builds carry a profile.
  static var isAppStore: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    let receipt = Bundle.main.appStoreReceiptURL?.lastPathComponent
    let profile = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision")
    return receipt == "receipt" && profile == nil
    #endif
  }

  static func mayRun(allowOutsideDebug: Bool) -> Bool {
    if isAppStore {
      log.fault("GrndwrkFeedback.start() was called in an App Store build. It does nothing here. Remove it from App Store builds.")
      return false
    }
    #if DEBUG
    return true
    #else
    if !allowOutsideDebug {
      log.fault("GrndwrkFeedback.start() was called in a build that is not Debug. It does nothing. For a tester build, start(allowOutsideDebug: true), and never submit that build to the App Store.")
      return false
    }
    log.warning("GrndwrkFeedback runs in a build that is not Debug. Never submit this build to the App Store.")
    return true
    #endif
  }
}
#endif
