// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "pdf-cli",
    platforms: [
        .macOS("26.0")
    ],
    targets: [
        .executableTarget(
            name: "pdf-cli",
            path: "Sources/pdf-cli"
        )
    ]
)
