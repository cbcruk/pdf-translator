// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "translate-cli",
    platforms: [
        .macOS("26.0")
    ],
    targets: [
        .executableTarget(
            name: "translate-cli",
            path: "Sources/translate-cli"
        )
    ]
)
