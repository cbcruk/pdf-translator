import type { ExtractedLine, ExtractedPage } from './ingest.types.js'
import type { Block } from './assemble.types.js'
import {
  commonLeftEdges,
  dominantFontSize,
  endsMidUrl,
  endsSentence,
  isOffGridEdge,
  joinLine,
  medianLineGap,
  removeFurniture,
} from './assemble.utils.js'

const HEADING_SCALE = 1.15
const HEADING_MAX_LENGTH = 150
const BOLD_HEADING_MAX_LENGTH = 80
const PARAGRAPH_GAP_RATIO = 1.35
const HEADING_MERGE_GAP_RATIO = 1.7
const FONT_SIZE_TOLERANCE = 0.6
const INDENT_THRESHOLD = 6
const BULLET_PATTERN = /^\s*([•◦▪‣·*–—-]|\d{1,2}[.)])\s+/
const TABLE_MIN_RUN = 3
const TABLE_X_TOLERANCE = 2
const TABLE_GAP_RATIO = 1.8

interface PositionedLine extends ExtractedLine {
  pageIndex: number
  isTable: boolean
}

export function assembleBlocks(
  pages: readonly ExtractedPage[],
  statisticsContext?: readonly ExtractedPage[]
): Block[] {
  const cleaned = removeFurniture(pages)
  // 페이지 범위를 잘라 조립해도 정렬선·본문 크기·줄 간격 통계는 문서
  // 전체 기준이어야 한다 (좁은 범위에선 표 들여쓰기가 다수처럼 보인다).
  const context = statisticsContext !== undefined ? removeFurniture(statisticsContext) : cleaned
  const edges = commonLeftEdges(context)
  const bodySizeSource = context.flatMap((page) => page.lines)
  if (cleaned.flatMap((page) => page.lines).length === 0 || bodySizeSource.length === 0) {
    return []
  }
  const bodySize = dominantFontSize(bodySizeSource)
  const lineStep = medianLineGap(context, bodySize)

  const lines: PositionedLine[] = cleaned.flatMap((page) => {
    const kept = page.lines.filter((line) => line.text.trim().length > 0)
    const tableFlags = markTableLines(kept, edges, lineStep)
    return kept.map((line, index) => ({
      ...line,
      pageIndex: page.index,
      isTable: tableFlags[index] ?? false,
    }))
  })
  if (lines.length === 0) {
    return []
  }

  const blocks: Block[] = []
  let buffer = ''
  let bufferType: Block['type'] = 'body'
  let tableRows: string[] = []
  let tableSource: Block['source']
  let previous: PositionedLine | undefined

  const flush = (): void => {
    if (tableRows.length > 0) {
      blocks.push({ type: 'table', text: tableRows.join('\n'), source: tableSource })
      tableRows = []
      tableSource = undefined
    }
    const text = buffer.trim()
    if (text.length > 0) {
      blocks.push({ type: bufferType, text })
    }
    buffer = ''
  }

  for (const line of lines) {
    const text = line.text.trim()

    if (line.isTable) {
      if (tableRows.length > 0 && previous !== undefined && line.pageIndex !== previous.pageIndex) {
        flush()
      }
      if (tableRows.length === 0) {
        flush()
        tableSource = { page: line.pageIndex, yTop: line.y + line.height, yBottom: line.y }
      } else if (tableSource !== undefined) {
        tableSource.yBottom = Math.min(tableSource.yBottom, line.y)
      }
      tableRows.push(text)
      previous = line
      continue
    }
    if (tableRows.length > 0) {
      flush()
    }

    const heading = isHeading(line, bodySize)
    if (heading !== (bufferType === 'heading' && buffer.length > 0)) {
      flush()
    } else if (
      buffer.length > 0 &&
      previous !== undefined &&
      startsNewBlock(previous, line, buffer, lineStep, heading)
    ) {
      flush()
    }

    bufferType = heading ? 'heading' : 'body'
    buffer = joinLine(buffer, text)
    previous = line
  }
  flush()

  return mergeSplitUrls(blocks)
}

function markTableLines(
  lines: readonly ExtractedLine[],
  edges: readonly number[],
  lineStep: number
): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false)
  let runStart = -1

  const closeRun = (end: number): void => {
    if (runStart >= 0 && end - runStart >= TABLE_MIN_RUN) {
      for (let i = runStart; i < end; i++) {
        flags[i] = true
      }
    }
    runStart = -1
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) {
      continue
    }
    const anchor = runStart >= 0 ? lines[runStart] : undefined
    const continuesRun =
      anchor !== undefined &&
      Math.abs(line.x - anchor.x) <= TABLE_X_TOLERANCE &&
      (lines[i - 1]?.y ?? 0) - line.y <= lineStep * TABLE_GAP_RATIO

    if (isOffGridEdge(line.x, edges) && !BULLET_PATTERN.test(line.text)) {
      if (!continuesRun) {
        closeRun(i)
        runStart = i
      }
    } else {
      closeRun(i)
    }
  }
  closeRun(lines.length)
  return flags
}

function isHeading(line: PositionedLine, bodySize: number): boolean {
  const text = line.text.trim()
  if (line.fontSize >= bodySize * HEADING_SCALE) {
    return text.length <= HEADING_MAX_LENGTH
  }
  return (
    line.bold &&
    line.fontSize >= bodySize &&
    text.length <= BOLD_HEADING_MAX_LENGTH &&
    !/[.,;]$/.test(text)
  )
}

function startsNewBlock(
  previous: PositionedLine,
  line: PositionedLine,
  buffer: string,
  lineStep: number,
  heading: boolean
): boolean {
  if (BULLET_PATTERN.test(line.text)) {
    return true
  }
  if (endsMidUrl(buffer)) {
    return false
  }
  if (Math.abs(line.fontSize - previous.fontSize) > FONT_SIZE_TOLERANCE) {
    return true
  }
  if (line.pageIndex !== previous.pageIndex) {
    return endsSentence(buffer)
  }

  const gap = previous.y - line.y
  if (gap <= 0) {
    return endsSentence(buffer)
  }
  if (gap > lineStep * (heading ? HEADING_MERGE_GAP_RATIO : PARAGRAPH_GAP_RATIO)) {
    return true
  }
  if (line.x - previous.x >= INDENT_THRESHOLD && endsSentence(buffer)) {
    return true
  }
  return false
}

// 문단 간격 신호가 긴 URL 한가운데를 자르면 뒷조각이 프로토콜 없이 시작해
// 마스킹·복원을 모두 비껴가므로, 블록 경계에서 다시 붙인다.
function mergeSplitUrls(blocks: Block[]): Block[] {
  const merged: Block[] = []
  for (const block of blocks) {
    const last = merged[merged.length - 1]
    if (
      last !== undefined &&
      last.type === 'body' &&
      block.type === 'body' &&
      endsMidUrl(last.text) &&
      /^([a-z0-9][\w.-]*[/?#]|\/\/)/.test(block.text)
    ) {
      last.text += block.text
      continue
    }
    merged.push({ ...block })
  }
  return merged
}
