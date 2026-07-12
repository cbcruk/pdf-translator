import AppKit
import CoreText
import Foundation

struct RenderBlock: Decodable {
    let type: String
    let text: String
    let rows: [[String]]?
}

struct RenderInput: Decodable {
    let blocks: [RenderBlock]
}

struct RenderResult: Encodable {
    let output: String
    let pageCount: Int
}

private let pageRect = CGRect(x: 0, y: 0, width: 612, height: 792)
private let textInset = 64.0

func runRender(_ args: [String]) {
    var outputPath: String?
    var rest = ArraySlice(args)
    while let arg = rest.popFirst() {
        switch arg {
        case "--output", "-o":
            guard let value = rest.popFirst() else { fail("--output requires a value", 1) }
            outputPath = value
        default:
            fail("unknown argument: \(arg)", 1)
        }
    }
    guard let outputPath else {
        fail("render requires --output <path>", 1)
    }

    guard let data = try? FileHandle.standardInput.readToEnd(), !data.isEmpty else {
        fail("expected render input JSON on stdin", 1)
    }
    guard let input = try? JSONDecoder().decode(RenderInput.self, from: data) else {
        fail("stdin is not valid render input JSON", 1)
    }
    guard !input.blocks.isEmpty else {
        fail("render input has no blocks", 1)
    }

    let composer = PDFComposer(outputPath: outputPath)
    composer.compose(input.blocks)
    let pageCount = composer.finish()
    printJSON(RenderResult(output: outputPath, pageCount: pageCount))
    exit(0)
}

// Apple SD Gothic Neo drops doubled Latin letters (e.g. "ll") when text is
// extracted back from a PDF, so Latin goes through Helvetica Neue and Korean
// is reached via the cascade list.
private func makeFont(latin: String, korean: String, size: Double) -> NSFont? {
    guard NSFont(name: korean, size: size) != nil else { return nil }
    let descriptor = NSFontDescriptor(name: latin, size: size).addingAttributes([
        .cascadeList: [NSFontDescriptor(name: korean, size: size)]
    ])
    return NSFont(descriptor: descriptor, size: size)
}

private final class PDFComposer {
    private let context: CGContext
    private let textRect = pageRect.insetBy(dx: textInset, dy: textInset)
    private var cursorY: CGFloat
    private var pageCount = 0
    private var pageOpen = false

    private let bodyFont: NSFont
    private let headingFont: NSFont
    private let tableFont: NSFont

    init(outputPath: String) {
        var mediaBox = pageRect
        guard let consumer = CGDataConsumer(url: URL(fileURLWithPath: outputPath) as CFURL),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil)
        else {
            fail("cannot create PDF at \(outputPath)", 3)
        }
        guard let body = makeFont(latin: "HelveticaNeue", korean: "AppleSDGothicNeo-Regular", size: 11),
              let heading = makeFont(latin: "HelveticaNeue-Bold", korean: "AppleSDGothicNeo-Bold", size: 16),
              let table = makeFont(latin: "HelveticaNeue", korean: "AppleSDGothicNeo-Regular", size: 9)
        else {
            fail("required fonts are not available", 3)
        }
        self.context = context
        self.bodyFont = body
        self.headingFont = heading
        self.tableFont = table
        self.cursorY = textRect.maxY
    }

    func compose(_ blocks: [RenderBlock]) {
        for block in blocks {
            switch block.type {
            case "table" where block.rows != nil:
                drawTable(block.rows ?? [])
            case "table":
                drawText(block.text, font: tableFont, lineHeight: 1.25, spacingBefore: 8, spacingAfter: 8, paragraphSpacing: 2)
            case "heading":
                drawText(block.text, font: headingFont, lineHeight: 1.3, spacingBefore: 16, spacingAfter: 10, paragraphSpacing: 0)
            default:
                drawText(block.text, font: bodyFont, lineHeight: 1.3, spacingBefore: 0, spacingAfter: 9, paragraphSpacing: 9)
            }
        }
    }

    func finish() -> Int {
        if pageOpen {
            context.endPDFPage()
            pageOpen = false
        }
        context.closePDF()
        return pageCount
    }

    private func beginPageIfNeeded() {
        if !pageOpen {
            context.beginPDFPage(nil)
            pageOpen = true
            pageCount += 1
            cursorY = textRect.maxY
        }
    }

    private func newPage() {
        if pageOpen {
            context.endPDFPage()
            pageOpen = false
        }
        beginPageIfNeeded()
    }

    private func remaining() -> CGFloat {
        cursorY - textRect.minY
    }

    private func attributed(
        _ text: String,
        font: NSFont,
        lineHeight: CGFloat,
        paragraphSpacing: CGFloat
    ) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.lineHeightMultiple = lineHeight
        style.paragraphSpacing = paragraphSpacing
        return NSAttributedString(string: text, attributes: [
            .font: font,
            .foregroundColor: NSColor.black,
            .paragraphStyle: style,
            .ligature: 0,
        ])
    }

    private func drawText(
        _ text: String,
        font: NSFont,
        lineHeight: CGFloat,
        spacingBefore: CGFloat,
        spacingAfter: CGFloat,
        paragraphSpacing: CGFloat
    ) {
        beginPageIfNeeded()
        if cursorY < textRect.maxY {
            cursorY -= spacingBefore
        }

        let content = attributed(text, font: font, lineHeight: lineHeight, paragraphSpacing: paragraphSpacing)
        let framesetter = CTFramesetterCreateWithAttributedString(content)
        var location = 0

        while location < content.length {
            let minLine = font.pointSize * lineHeight * 1.2
            if remaining() < minLine {
                newPage()
            }
            let available = remaining()
            let path = CGPath(
                rect: CGRect(x: textRect.minX, y: cursorY - available, width: textRect.width, height: available),
                transform: nil
            )
            let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: location, length: 0), path, nil)
            let visible = CTFrameGetVisibleStringRange(frame)
            if visible.length == 0 {
                newPage()
                continue
            }
            CTFrameDraw(frame, context)

            var fit = CFRange()
            let used = CTFramesetterSuggestFrameSizeWithConstraints(
                framesetter,
                CFRange(location: location, length: visible.length),
                nil,
                CGSize(width: textRect.width, height: .greatestFiniteMagnitude),
                &fit
            )
            cursorY -= used.height
            location += visible.length
        }
        cursorY -= spacingAfter
    }

    private func drawTable(_ rows: [[String]]) {
        guard !rows.isEmpty else { return }
        beginPageIfNeeded()
        if cursorY < textRect.maxY {
            cursorY -= 10
        }

        let columnCount = rows.map(\.count).max() ?? 1
        let normalized = rows.map { row in
            row + Array(repeating: "", count: columnCount - row.count)
        }
        let cellInsetX = 5.0
        let cellInsetY = 3.0

        var naturalWidths = [CGFloat](repeating: 12, count: columnCount)
        for row in normalized {
            for (column, cell) in row.enumerated() where !cell.isEmpty {
                let line = CTLineCreateWithAttributedString(
                    attributed(cell, font: tableFont, lineHeight: 1.15, paragraphSpacing: 0)
                )
                let width = CTLineGetTypographicBounds(line, nil, nil, nil) + cellInsetX * 2
                naturalWidths[column] = max(naturalWidths[column], width)
            }
        }
        let naturalTotal = naturalWidths.reduce(0, +)
        let scale = naturalTotal > textRect.width ? textRect.width / naturalTotal : 1
        let widths = naturalWidths.map { $0 * scale }
        let tableWidth = widths.reduce(0, +)

        for row in normalized {
            var cells: [(content: NSAttributedString, height: CGFloat)] = []
            for (column, cell) in row.enumerated() {
                let content = attributed(cell, font: tableFont, lineHeight: 1.15, paragraphSpacing: 0)
                let framesetter = CTFramesetterCreateWithAttributedString(content)
                var fit = CFRange()
                let size = CTFramesetterSuggestFrameSizeWithConstraints(
                    framesetter,
                    CFRange(location: 0, length: content.length),
                    nil,
                    CGSize(width: widths[column] - cellInsetX * 2, height: .greatestFiniteMagnitude),
                    &fit
                )
                cells.append((content, size.height))
            }
            let rowHeight = (cells.map(\.height).max() ?? tableFont.pointSize) + cellInsetY * 2

            if remaining() < rowHeight {
                newPage()
            }
            let rowTop = cursorY
            let rowBottom = rowTop - rowHeight

            context.setStrokeColor(NSColor(white: 0.55, alpha: 1).cgColor)
            context.setLineWidth(0.5)
            var x = textRect.minX
            for width in widths {
                context.stroke(CGRect(x: x, y: rowBottom, width: width, height: rowHeight))
                x += width
            }
            _ = tableWidth

            x = textRect.minX
            for (column, cell) in cells.enumerated() {
                let cellRect = CGRect(
                    x: x + cellInsetX,
                    y: rowBottom + cellInsetY,
                    width: widths[column] - cellInsetX * 2,
                    height: rowHeight - cellInsetY * 2
                )
                let framesetter = CTFramesetterCreateWithAttributedString(cells[column].content)
                let frame = CTFramesetterCreateFrame(
                    framesetter,
                    CFRange(location: 0, length: 0),
                    CGPath(rect: cellRect, transform: nil),
                    nil
                )
                CTFrameDraw(frame, context)
                x += widths[column]
            }
            cursorY = rowBottom
        }
        cursorY -= 10
    }
}

