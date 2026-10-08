// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "GroundworkFeedback",
  platforms: [.iOS(.v15)],
  products: [.library(name: "GroundworkFeedback", targets: ["GroundworkFeedback"])],
  targets: [.target(name: "GroundworkFeedback")]
)
