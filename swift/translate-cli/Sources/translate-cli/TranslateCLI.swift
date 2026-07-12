import Foundation
import Translation

struct TranslatedLine: Encodable {
    let index: Int
    let sourceText: String
    let targetText: String
}

struct CheckResult: Encodable {
    let status: String
    let source: String
    let target: String
}

enum ExitCode: Int32 {
    case ok = 0
    case usage = 1
    case notInstalled = 2
    case unsupported = 3
    case translationFailed = 4
}

@main
struct TranslateCLI {
    static func main() async {
        await run()
    }

    nonisolated static func run() async {
        var source = "en"
        var target = "ko"
        var checkOnly = false

        var args = ArraySlice(CommandLine.arguments.dropFirst())
        while let arg = args.popFirst() {
            switch arg {
            case "--source":
                guard let value = args.popFirst() else { fail("--source requires a value", .usage) }
                source = value
            case "--target":
                guard let value = args.popFirst() else { fail("--target requires a value", .usage) }
                target = value
            case "--check":
                checkOnly = true
            case "--help", "-h":
                printUsage()
                exit(ExitCode.ok.rawValue)
            default:
                fail("unknown argument: \(arg)", .usage)
            }
        }

        let sourceLanguage = Locale.Language(identifier: source)
        let targetLanguage = Locale.Language(identifier: target)

        let availability = LanguageAvailability()
        let status = await availability.status(from: sourceLanguage, to: targetLanguage)

        if checkOnly {
            let result = CheckResult(status: statusName(status), source: source, target: target)
            printJSONLine(result)
            exit(ExitCode.ok.rawValue)
        }

        switch status {
        case .installed:
            break
        case .supported:
            fail(
                "language pair \(source)->\(target) is supported but not installed. "
                    + "Install via System Settings > General > Language & Region > Translation Languages, "
                    + "or open the Translate app and download both languages.",
                .notInstalled
            )
        case .unsupported:
            fail("language pair \(source)->\(target) is not supported", .unsupported)
        @unknown default:
            fail("unknown availability status for \(source)->\(target)", .unsupported)
        }

        let texts = readInputTexts()
        if texts.isEmpty {
            exit(ExitCode.ok.rawValue)
        }

        let session = TranslationSession(installedSource: sourceLanguage, target: targetLanguage)
        let requests = texts.map { TranslationSession.Request(sourceText: $0) }

        do {
            let responses = try await session.translations(from: requests)
            for (index, response) in responses.enumerated() {
                printJSONLine(TranslatedLine(
                    index: index,
                    sourceText: response.sourceText,
                    targetText: response.targetText
                ))
            }
        } catch {
            fail("translation failed: \(error)", .translationFailed)
        }

        exit(ExitCode.ok.rawValue)
    }

    static func readInputTexts() -> [String] {
        guard let data = try? FileHandle.standardInput.readToEnd(), !data.isEmpty else {
            fail("expected a JSON array of strings on stdin", .usage)
        }
        guard let texts = try? JSONDecoder().decode([String].self, from: data) else {
            fail("stdin is not a valid JSON array of strings", .usage)
        }
        return texts
    }

    static func statusName(_ status: LanguageAvailability.Status) -> String {
        switch status {
        case .installed: return "installed"
        case .supported: return "supported"
        case .unsupported: return "unsupported"
        @unknown default: return "unknown"
        }
    }

    static func printJSONLine(_ value: some Encodable) {
        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(value), let line = String(data: data, encoding: .utf8) else {
            fail("failed to encode output as JSON", .translationFailed)
        }
        print(line)
    }

    static func fail(_ message: String, _ code: ExitCode) -> Never {
        FileHandle.standardError.write(Data("translate-cli: \(message)\n".utf8))
        exit(code.rawValue)
    }

    static func printUsage() {
        print("""
        usage: translate-cli [--source <lang>] [--target <lang>] [--check]

        Reads a JSON array of strings from stdin and writes one JSON object
        per line ({"index","sourceText","targetText"}) to stdout, in input order.
        Defaults: --source en --target ko.

        --check  print language pair availability as JSON and exit.

        exit codes: 0 ok, 1 usage/input error, 2 pair not installed,
                    3 pair unsupported, 4 translation failure.
        """)
    }
}
