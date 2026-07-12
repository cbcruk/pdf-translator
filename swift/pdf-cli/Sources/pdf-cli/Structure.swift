import AppKit
import Foundation
import PDFKit
import Vision

struct StructuredBox: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct StructuredParagraph: Encodable {
    let text: String
    let box: StructuredBox
    let lineCount: Int
}

struct StructuredTable: Encodable {
    let box: StructuredBox
    let rows: [[String]]
}

struct StructuredList: Encodable {
    let box: StructuredBox
    let items: [String]
}

struct StructuredPage: Encodable {
    let index: Int
    let width: Double
    let height: Double
    let title: String?
    let paragraphs: [StructuredParagraph]
    let tables: [StructuredTable]
    let lists: [StructuredList]
}

struct StructureResult: Encodable {
    let pageCount: Int
    let pages: [StructuredPage]
}

func runStructure(_ args: [String]) async {
    var path: String?
    var languages = ["ko-KR", "en-US"]
    var scale = 3.0
    var pageFilter: Set<Int>?

    var rest = ArraySlice(args)
    while let arg = rest.popFirst() {
        switch arg {
        case "--pages":
            guard let value = rest.popFirst() else { fail("--pages requires a value", 1) }
            pageFilter = Set(value.split(separator: ",").compactMap { Int($0) })
        case "--languages":
            guard let value = rest.popFirst() else { fail("--languages requires a value", 1) }
            languages = value.split(separator: ",").map(String.init)
        case "--scale":
            guard let value = rest.popFirst(), let parsed = Double(value) else {
                fail("--scale requires a number", 1)
            }
            scale = parsed
        default:
            if path == nil, !arg.hasPrefix("-") {
                path = arg
            } else {
                fail("unknown argument: \(arg)", 1)
            }
        }
    }
    guard let path else {
        fail("expected a PDF path argument", 1)
    }
    guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
        fail("cannot open PDF: \(path)", 2)
    }

    var request = RecognizeDocumentsRequest()
    request.textRecognitionOptions.recognitionLanguages = languages.map { Locale.Language(identifier: $0) }
    request.textRecognitionOptions.useLanguageCorrection = true

    var pages: [StructuredPage] = []
    for index in 0..<document.pageCount {
        if let pageFilter, !pageFilter.contains(index) { continue }
        guard let page = document.page(at: index) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        let thumbnail = page.thumbnail(of: size, for: .mediaBox)
        var proposedRect = CGRect(origin: .zero, size: thumbnail.size)
        guard let cgImage = thumbnail.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
            pages.append(StructuredPage(
                index: index, width: bounds.width, height: bounds.height,
                title: nil, paragraphs: [], tables: [], lists: []
            ))
            continue
        }

        do {
            let observations = try await request.perform(on: cgImage)
            let container = observations.first?.document
            pages.append(structuredPage(from: container, index: index, bounds: bounds))
        } catch {
            fail("document recognition failed on page \(index): \(error)", 3)
        }
    }

    printJSON(StructureResult(pageCount: document.pageCount, pages: pages))
    exit(0)
}

private func structuredPage(
    from container: DocumentObservation.Container?,
    index: Int,
    bounds: CGRect
) -> StructuredPage {
    guard let container else {
        return StructuredPage(
            index: index, width: bounds.width, height: bounds.height,
            title: nil, paragraphs: [], tables: [], lists: []
        )
    }

    let paragraphs = container.paragraphs.map { text in
        StructuredParagraph(
            text: text.transcript,
            box: box(of: text.boundingRegion, in: bounds),
            lineCount: text.lines.count
        )
    }
    let tables = container.tables.map { table in
        StructuredTable(
            box: box(of: table.boundingRegion, in: bounds),
            rows: table.rows.map { row in
                row.map { cell in
                    cell.content.text.transcript.replacingOccurrences(of: "\n", with: " ")
                }
            }
        )
    }
    let lists = container.lists.map { list in
        StructuredList(
            box: box(of: list.boundingRegion, in: bounds),
            items: list.items.map { item in
                item.itemString.replacingOccurrences(of: "\n", with: " ")
            }
        )
    }

    return StructuredPage(
        index: index,
        width: bounds.width,
        height: bounds.height,
        title: container.title?.transcript,
        paragraphs: paragraphs,
        tables: tables,
        lists: lists
    )
}

private func box(of region: NormalizedRegion, in bounds: CGRect) -> StructuredBox {
    let rect = region.normalizedPath.boundingBox
    return StructuredBox(
        x: rect.minX * bounds.width,
        y: rect.minY * bounds.height,
        width: rect.width * bounds.width,
        height: rect.height * bounds.height
    )
}
