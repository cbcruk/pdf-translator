import type { Block } from './assemble.types.js'
import type { StructuredPage, StructuredTable } from './ingest.types.js'

/** 단독 페이지 번호 판정 패턴 (머리글/바닥글 제거용). */
const PAGE_NUMBER_PATTERN = /^\s*(page\s+)?\d+(\s+of\s+\d+)?\s*$/i
/** 한 줄 문단의 줄 높이가 중앙값의 이 배수를 넘으면 헤딩으로 본다. */
const HEADING_HEIGHT_SCALE = 1.3

/** 페이지 내 요소를 세로 위치로 정렬하기 위한 임시 래퍼 (top = 요소 상단 y). */
interface OrderedElement {
  top: number
  block: Block
}

/**
 * 스캔 경로 전용 조립. Vision `RecognizeDocumentsRequest`가 문단/제목/표/리스트를 이미
 * 그룹핑해 주므로, 줄 조립을 거치지 않고 요소들을 페이지별로 읽기 순서(위→아래)로 펼치기만 한다.
 * 문단 줄 높이의 중앙값을 기준으로 큰 한 줄 문단을 헤딩으로 승격하고, 페이지 번호는 걷어낸다.
 */
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

/** Vision 표를 Block으로 변환한다. rows를 보존하고, text는 강등 시 쓸 평문 표현으로 둔다. */
function tableBlock(table: StructuredTable): Block {
  return {
    type: 'table',
    text: table.rows.map((row) => row.join(' ')).join('\n'),
    rows: table.rows,
  }
}

/** 페이지 상·하단 12% 영역에 놓인 단독 페이지 번호인지 (걷어낼 머리글/바닥글). */
function isFurniture(text: string, y: number, pageHeight: number): boolean {
  if (!PAGE_NUMBER_PATTERN.test(text)) {
    return false
  }
  const zone = pageHeight * 0.12
  return y <= zone || y >= pageHeight - zone
}

/** 중앙값. 빈 배열이면 0. */
function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
