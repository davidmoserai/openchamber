// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ane-dictation-helper",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4"),
    ],
    targets: [
        .executableTarget(
            name: "ane-dictation-helper",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        )
    ]
)
