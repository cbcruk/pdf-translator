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

/** 본문 크기 대비 이 배수 이상이면 헤딩 후보. */
const HEADING_SCALE = 1.15
/** 큰 폰트 헤딩으로 인정하는 최대 글자 수 (그 이상은 본문 문장으로 본다). */
const HEADING_MAX_LENGTH = 150
/** 볼드만으로 헤딩 판정할 때의 최대 글자 수 (더 보수적). */
const BOLD_HEADING_MAX_LENGTH = 80
/** 본문에서 줄 간격이 중앙값의 이 배수를 넘으면 문단을 나눈다. */
const PARAGRAPH_GAP_RATIO = 1.35
/** 헤딩은 아래 여백이 넓으므로 문단보다 큰 배수를 적용해 과분할을 막는다. */
const HEADING_MERGE_GAP_RATIO = 1.7
/** 폰트 크기가 이보다 크게 바뀌면 다른 블록으로 본다 (pt). */
const FONT_SIZE_TOLERANCE = 0.6
/** 새 문단으로 볼 들여쓰기 최소 폭 (pt). */
const INDENT_THRESHOLD = 6
/** 글머리표·번호 매김 목록 마커. 만나면 새 블록을 시작한다. */
const BULLET_PATTERN = /^\s*([•◦▪‣·*–—-]|\d{1,2}[.)])\s+/
/** 표로 인정하는 최소 연속 줄 수 (정렬선에서 벗어난 x를 공유하는 줄의 런). */
const TABLE_MIN_RUN = 3
/** 표 런이 같은 열로 이어진다고 볼 x 허용 오차 (pt). */
const TABLE_X_TOLERANCE = 2
/** 표 런이 끊기지 않고 이어진다고 볼 세로 간격 상한 (줄 간격의 배수). */
const TABLE_GAP_RATIO = 1.8

/** 조립 과정에서만 쓰는 확장 줄: 원본 줄 + 소속 페이지 + 표 여부. */
interface PositionedLine extends ExtractedLine {
  pageIndex: number
  isTable: boolean
}

/**
 * 추출된 줄들을 문단/헤딩/표 블록으로 조립한다. 파이프라인의 핵심 — 번역 품질은
 * 문단 단위 문맥에서 나오므로 줄을 문단으로 올바로 묶는 것이 관건이다. 문서 전체 통계
 * (줄 간격 중앙값·흔한 정렬선·본문 폰트 크기)를 기준으로 세로 간격·폰트 변화·들여쓰기·
 * 글머리표에서 문단을 나눈다.
 *
 * @param pages 조립 대상 페이지들 (`--pages`로 범위를 자를 수 있음)
 * @param statisticsContext 통계 산출용 페이지들. 범위를 잘라 조립하더라도 정렬선·본문 크기·
 *   줄 간격은 문서 전체 기준이어야 하므로 별도로 넘긴다 (좁은 범위에선 표 들여쓰기가 다수처럼
 *   보인다). 생략 시 `pages`로 통계를 낸다.
 * @returns 읽기 순서의 블록 배열 (줄 걸쳐 끊긴 URL은 블록 경계에서 재결합됨)
 */
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

  // 누적 중인 표 행과 문단 버퍼를 각각 블록으로 확정하고 비운다.
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

/**
 * 각 줄이 표(또는 코드 블록)에 속하는지 표시한다. 본문 정렬선에서 벗어난 x를 같은 열로
 * 유지하며 세로로 이어지는 줄이 {@link TABLE_MIN_RUN}개 이상 연속될 때만 그 런을 표로 확정한다.
 * 글머리표로 시작하는 줄은 목록이므로 표에서 제외한다.
 *
 * @returns lines와 같은 길이의 boolean 배열 (표 줄이면 true)
 */
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

/**
 * 한 줄이 헤딩인지 판정한다. 본문보다 뚜렷이 큰 폰트(길이 제한 하)거나, 볼드이면서
 * 본문 이상 크기의 짧고 문장부호로 끝나지 않는 줄이면 헤딩으로 본다.
 */
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

/**
 * 현재 줄이 누적 중인 버퍼와 끊겨 새 블록을 시작해야 하는지 판정한다. 글머리표·폰트 변화·
 * 넓은 세로 간격·문장 종결 후의 들여쓰기를 경계 신호로 보되, URL 도중이면 절대 끊지 않는다.
 * 페이지가 바뀌거나 줄이 겹칠 때는 문장이 끝났는지로 판단한다.
 *
 * @param heading 현재 줄이 헤딩인지 — 헤딩엔 더 큰 간격 배수를 적용한다
 */
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

/**
 * 블록 경계에서 끊긴 URL을 다시 붙인다. 문단 간격 신호가 긴 URL 한가운데를 자르면 뒷조각이
 * 프로토콜 없이 시작해 마스킹·복원을 모두 비껴가므로, 앞 블록이 URL 도중에 끝나고 뒤 블록이
 * URL 잔여부로 시작하면 하나로 합친다.
 */
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
