// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "GrndwrkFeedback",
  platforms: [.iOS(.v15)],
  products: [.library(name: "GrndwrkFeedback", targets: ["GrndwrkFeedback"])],
  targets: [.target(name: "GrndwrkFeedback")]
)
