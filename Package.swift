// swift-tools-version:5.9
// The iOS Comment button, for adding grndwrk to an app from GitHub (File, Add Package Dependencies,
// this repository's address). The package itself lives in clients/ios/GrndwrkFeedback; this file
// only points Xcode there, because Xcode reads a package's manifest from the top of the repository.
import PackageDescription

let package = Package(
  name: "GrndwrkFeedback",
  platforms: [.iOS(.v15)],
  products: [.library(name: "GrndwrkFeedback", targets: ["GrndwrkFeedback"])],
  targets: [.target(name: "GrndwrkFeedback", path: "clients/ios/GrndwrkFeedback/Sources/GrndwrkFeedback")]
)
