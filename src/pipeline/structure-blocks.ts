import type { Block } from './assemble.types.js'
import type { StructuredPage, StructuredTable } from './ingest.types.js'

const PAGE_NUMBER_PATTERN = /^\s*(page\s+)?\d+(\s+of\s+\d+)?\s*$/i
const HEADING_HEIGHT_SCALE = 1.3

interface OrderedElement {
  top: number
  block: Block
}

// 스캔본은 RecognizeDocumentsRequest가 문단/제목/표/리스트를 이미 그룹핑해
// 주므로, 줄 조립을 거치지 않고 요소들을 읽기 순서로 펼치기만 한다.
export function blocksFromStructure(pages: readonly StructuredPage[]): Block[] {
  const lineHeights = pages.flatMap((page) =>
    page.paragraphs
      .filter((paragraph) => paragraph.lineCount > 0)
      .map((paragraph) => paragraph.box.height / paragraph.lineCount)
  )
  const medianLineHeight = median(lineHeights)

  const blocks: Block[] = []
  for (const page of pages) {
    const elements: OrderedElement[] = []

    for (const paragraph of page.paragraphs) {
      const text = paragraph.text.replace(/\s*\n\s*/g, ' ').trim()
      if (text.length === 0 || isFurniture(text, paragraph.box.y, page.height)) {
        continue
      }
      const lineHeight = paragraph.box.height / Math.max(paragraph.lineCount, 1)
      const isHeading =
        text === page.title ||
        (paragraph.lineCount === 1 &&
          medianLineHeight > 0 &&
          lineHeight > medianLineHeight * HEADING_HEIGHT_SCALE &&
          text.length <= 150)
      elements.push({
        top: paragraph.box.y + paragraph.box.height,
        block: { type: isHeading ? 'heading' : 'body', text },
      })
    }

    for (const table of page.tables) {
      elements.push({
        top: table.box.y + table.box.height,
        block: tableBlock(table),
      })
    }

    for (const list of page.lists) {
      const text = list.items
        .map((item) => `• ${item.trim()}`)
        .join('\n')
      if (text.length > 0) {
        elements.push({
          top: list.box.y + list.box.height,
          block: { type: 'body', text },
        })
      }
    }

    elements.sort((a, b) => b.top - a.top)
    blocks.push(...elements.map((element) => element.block))
  }
  return blocks
}

function tableBlock(table: StructuredTable): Block {
  return {
    type: 'table',
    text: table.rows.map((row) => row.join(' ')).join('\n'),
    rows: table.rows,
  }
}

function isFurniture(text: string, y: number, pageHeight: number): boolean {
  if (!PAGE_NUMBER_PATTERN.test(text)) {
    return false
  }
  const zone = pageHeight * 0.12
  return y <= zone || y >= pageHeight - zone
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
