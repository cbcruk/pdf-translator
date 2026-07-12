import AppKit
import Foundation
import PDFKit

struct InfoResult: Encodable {
    let pageCount: Int
    let hasTextLayer: Bool
}

struct ExtractedLine: Encodable {
    let text: String
    let fontSize: Double
    let bold: Bool
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct ExtractedPage: Encodable {
    let index: Int
    let width: Double
    let height: Double
    let lines: [ExtractedLine]
}

struct ExtractResult: Encodable {
    let pageCount: Int
    let pages: [ExtractedPage]
}

private func openDocument(_ args: [String]) -> PDFDocument {
    guard let path = args.first else {
        fail("expected a PDF path argument", 1)
    }
    let url = URL(fileURLWithPath: path)
    guard let document = PDFDocument(url: url) else {
        fail("cannot open PDF: \(path)", 2)
    }
    return document
}

func runInfo(_ args: [String]) {
    let document = openDocument(args)
    let sampleCount = min(document.pageCount, 5)
    var characterCount = 0
    for index in 0..<sampleCount {
        guard let page = document.page(at: index), let text = page.string else { continue }
        characterCount += text.trimmingCharacters(in: .whitespacesAndNewlines).count
    }
    printJSON(InfoResult(pageCount: document.pageCount, hasTextLayer: characterCount > 50))
    exit(0)
}

func runExtract(_ args: [String]) {
    let document = openDocument(args)
    var pages: [ExtractedPage] = []
    for index in 0..<document.pageCount {
        guard let page = document.page(at: index) else {
            pages.append(ExtractedPage(index: index, width: 0, height: 0, lines: []))
            continue
        }
        let bounds = page.bounds(for: .mediaBox)
        pages.append(ExtractedPage(
            index: index,
            width: bounds.width,
            height: bounds.height,
            lines: extractLines(from: page)
        ))
    }
    printJSON(ExtractResult(pageCount: document.pageCount, pages: pages))
    exit(0)
}

private func extractLines(from page: PDFPage) -> [ExtractedLine] {
    guard let attributed = page.attributedString else { return [] }
    let text = attributed.string as NSString
    var lines: [ExtractedLine] = []

    text.enumerateSubstrings(in: NSRange(location: 0, length: text.length), options: .byLines) { substring, range, _, _ in
        guard let substring, !substring.trimmingCharacters(in: .whitespaces).isEmpty else { return }

        var fontSize = 0.0
        var bold = false
        if let font = attributed.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont {
            fontSize = Double(font.pointSize)
            bold = font.fontDescriptor.symbolicTraits.contains(.bold)
        }

        var box = CGRect.zero
        if let selection = page.selection(for: range) {
            box = selection.bounds(for: page)
        }

        lines.append(ExtractedLine(
            text: substring,
            fontSize: fontSize,
            bold: bold,
            x: box.minX,
            y: box.minY,
            width: box.width,
            height: box.height
        ))
    }
    return lines
}
