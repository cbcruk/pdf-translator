import type { ExtractedLine, ExtractedPage } from './ingest.types.js'

/** 머리글/바닥글로 취급하는 페이지 상·하단 영역의 비율 (페이지 높이의 12%). */
const FURNITURE_ZONE_RATIO = 0.12
/** 단독 페이지 번호 판정: 아라비아 숫자("12", "3 of 10")나 로마 숫자("iv"). */
const PAGE_NUMBER_PATTERN = /^\s*(page\s+)?\d+(\s+of\s+\d+)?\s*$|^\s*[ivxlcdm]+\s*$/i
/** 목차 점선 리더("....") 패턴. */
const DOT_LEADER_PATTERN = /(\.\s+){3,}/
/** 한 페이지가 목차로 판정되는 최소 점선 리더 줄 수. */
const TOC_PAGE_MIN_LEADERS = 3

/**
 * 문서에서 가장 흔한 폰트 크기를 본문 크기로 추정한다. 줄 수가 아니라 **글자 수로
 * 가중**하므로, 짧은 헤딩이 많아도 본문 크기가 흔들리지 않는다. 0.5pt 단위로 반올림해 집계한다.
 */
export function dominantFontSize(lines: readonly ExtractedLine[]): number {
  const weights = new Map<number, number>()
  for (const line of lines) {
    const size = Math.round(line.fontSize * 2) / 2
    weights.set(size, (weights.get(size) ?? 0) + line.text.length)
  }
  let bestSize = 0
  let bestWeight = -1
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      bestSize = size
      bestWeight = weight
    }
  }
  return bestSize
}

/**
 * 연속한 두 줄의 세로 간격 중앙값. 문단 나눔 임계(1.35×)의 기준 단위가 된다.
 * 문단 사이의 큰 공백에 휘둘리지 않게 줄 높이의 2.5배를 넘는 간격은 표본에서 제외한다.
 *
 * @param bodySize 유효한 간격이 하나도 없을 때의 대체값 계산에 쓰이는 본문 폰트 크기
 * @returns 간격 중앙값. 표본이 없으면 `bodySize * 1.5`
 */
export function medianLineGap(pages: readonly ExtractedPage[], bodySize: number): number {
  const gaps: number[] = []
  for (const page of pages) {
    for (let i = 1; i < page.lines.length; i++) {
      const prev = page.lines[i - 1]
      const line = page.lines[i]
      if (prev === undefined || line === undefined) {
        continue
      }
      const gap = prev.y - line.y
      const limit = Math.max(prev.height, line.height) * 2.5
      if (gap > 0 && gap <= limit) {
        gaps.push(gap)
      }
    }
  }
  if (gaps.length === 0) {
    return bodySize * 1.5
  }
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] ?? bodySize * 1.5
}

/** 텍스트가 문장 종결 부호(닫는 따옴표·괄호까지 허용)로 끝나는지. 문단 경계 판정에 쓰인다. */
export function endsSentence(text: string): boolean {
  return /[.!?…:]["')\]]?$/.test(text)
}

/**
 * 텍스트가 URL 도중에 끊긴 채 끝나는지 판정한다. LaTeX류 조판은 URL을 "https:" 뒤나
 * "/" 뒤 등 임의 지점에서 줄바꿈하므로, 이 경우 다음 줄을 공백 없이 이어 붙여야 한다.
 */
export function endsMidUrl(text: string): boolean {
  const lastToken = text.slice(text.lastIndexOf(' ') + 1)
  return /^https?:$/.test(lastToken) || /(https?:\/\/|www\.)\S*[/=?&_.-]$/.test(lastToken)
}

/**
 * 문단 버퍼에 다음 줄을 이어 붙인다. 줄 끝 하이픈(어절 분철)은 제거하고 붙이며,
 * URL 도중이면 공백 없이, 그 외에는 공백 하나를 넣어 결합한다.
 */
export function joinLine(buffer: string, text: string): string {
  if (buffer.length === 0) {
    return text
  }
  if (buffer.endsWith('-')) {
    return buffer.slice(0, -1) + text
  }
  if (endsMidUrl(buffer)) {
    return buffer + text
  }
  return `${buffer} ${text}`
}

/**
 * 문서에서 흔히 반복되는 왼쪽 정렬선(x 좌표)들을 찾는다. 표/코드 블록은 본문의
 * 정렬선에서 벗어난 x를 여러 줄 공유하므로, 이 "본문 정렬선" 집합이 표 감지의 기준이 된다.
 * 전체 줄의 5%(최소 3줄) 이상이 모이는 x만 정렬선으로 채택한다.
 */
export function commonLeftEdges(pages: readonly ExtractedPage[]): number[] {
  const counts = new Map<number, number>()
  let total = 0
  for (const page of pages) {
    for (const line of page.lines) {
      counts.set(Math.round(line.x), (counts.get(Math.round(line.x)) ?? 0) + 1)
      total++
    }
  }
  const edges: number[] = []
  for (const [edge, count] of counts) {
    if (count >= Math.max(3, total * 0.05)) {
      edges.push(edge)
    }
  }
  return edges
}

/** x가 어느 본문 정렬선과도 6pt 넘게 떨어져 있는지 (즉 표/코드 후보 줄인지). */
export function isOffGridEdge(x: number, edges: readonly number[]): boolean {
  return edges.every((edge) => Math.abs(x - edge) > 6)
}

/**
 * 머리글/바닥글·페이지 번호·회전 텍스트·목차 줄을 본문 조립 전에 걷어낸다.
 * 상·하단 영역(12%)에서 여러 페이지에 걸쳐 같은 자리에 반복되는 줄, 단독 페이지 번호,
 * 세로로 선 회전 텍스트(arXiv 스탬프 등), 점선 리더가 많은 목차 페이지의 리더·번호가 대상이다.
 *
 * @returns 원본을 건드리지 않은, 걸러진 줄만 남은 새 페이지 배열
 */
export function removeFurniture(pages: readonly ExtractedPage[]): ExtractedPage[] {
  const repeats = new Map<string, number>()
  for (const page of pages) {
    for (const line of page.lines) {
      const key = furnitureKey(line, page)
      if (key !== undefined) {
        repeats.set(key, (repeats.get(key) ?? 0) + 1)
      }
    }
  }

  const threshold = Math.max(2, Math.ceil(pages.length * 0.5))
  return pages.map((page) => {
    // 점선 리더가 여럿이면 목차 페이지 — 리더 줄과 고아 페이지 번호는
    // 리플로우 문서에서 의미가 없으므로 함께 걷어낸다.
    const isTocPage =
      page.lines.filter((line) => DOT_LEADER_PATTERN.test(line.text)).length >=
      TOC_PAGE_MIN_LEADERS

    return {
      ...page,
      lines: page.lines.filter((line) => {
        if (isRotated(line)) {
          return false
        }
        if (isTocPage && (DOT_LEADER_PATTERN.test(line.text) || PAGE_NUMBER_PATTERN.test(line.text))) {
          return false
        }
        if (!inFurnitureZone(line, page)) {
          return true
        }
        if (PAGE_NUMBER_PATTERN.test(line.text)) {
          return false
        }
        const key = furnitureKey(line, page)
        return key === undefined || pages.length < 3 || (repeats.get(key) ?? 0) < threshold
      }),
    }
  })
}

/** 세로로 선 회전 텍스트인지 (높이가 폭·폰트에 비해 비정상적으로 큼) — arXiv 측면 스탬프 등. */
function isRotated(line: ExtractedLine): boolean {
  return (
    line.text.length > 1 &&
    line.height > line.width * 2 &&
    line.height > line.fontSize * 4
  )
}

/** 줄이 페이지 상·하단의 머리글/바닥글 영역(높이의 12%) 안에 있는지. */
function inFurnitureZone(line: ExtractedLine, page: ExtractedPage): boolean {
  if (page.height <= 0) {
    return false
  }
  const zone = page.height * FURNITURE_ZONE_RATIO
  return line.y + line.height >= page.height - zone || line.y <= zone
}

/**
 * 반복 머리글/바닥글을 셀 때 쓰는 정규화 키. 위치(상/하단)·대략적 y·숫자를 `#`으로
 * 치운 텍스트를 묶어, 페이지마다 번호만 바뀌는 바닥글도 같은 줄로 집계되게 한다.
 *
 * @returns 머리글/바닥글 영역 밖의 줄이면 undefined
 */
function furnitureKey(line: ExtractedLine, page: ExtractedPage): string | undefined {
  if (!inFurnitureZone(line, page)) {
    return undefined
  }
  const position = line.y >= page.height / 2 ? 'top' : 'bottom'
  const normalized = line.text.trim().replace(/\d+/g, '#')
  return `${position}:${Math.round(line.y / 10)}:${normalized}`
}
