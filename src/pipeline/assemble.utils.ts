import type { ExtractedLine, ExtractedPage } from './ingest.types.js'

const FURNITURE_ZONE_RATIO = 0.12
const PAGE_NUMBER_PATTERN = /^\s*(page\s+)?\d+(\s+of\s+\d+)?\s*$|^\s*[ivxlcdm]+\s*$/i
const DOT_LEADER_PATTERN = /(\.\s+){3,}/
const TOC_PAGE_MIN_LEADERS = 3

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

export function endsSentence(text: string): boolean {
  return /[.!?…:]["')\]]?$/.test(text)
}

// LaTeX류 조판은 URL을 "https:" 뒤나 "/" 뒤 등 임의 지점에서 줄바꿈한다.
export function endsMidUrl(text: string): boolean {
  const lastToken = text.slice(text.lastIndexOf(' ') + 1)
  return /^https?:$/.test(lastToken) || /(https?:\/\/|www\.)\S*[/=?&_.-]$/.test(lastToken)
}

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

// 표/코드 블록은 본문의 왼쪽 정렬선에서 벗어난 x를 3줄 이상 공유한다.
// 문서 전체에서 흔한 정렬선(전체 줄의 5% 이상)을 본문 기준으로 삼는다.
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

export function isOffGridEdge(x: number, edges: readonly number[]): boolean {
  return edges.every((edge) => Math.abs(x - edge) > 6)
}

// 여러 페이지에서 같은 자리(상/하단 8%)에 반복되는 줄과 단독 페이지 번호는
// 머리글/바닥글로 보고 본문 조립 전에 걷어낸다.
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

function isRotated(line: ExtractedLine): boolean {
  return (
    line.text.length > 1 &&
    line.height > line.width * 2 &&
    line.height > line.fontSize * 4
  )
}

function inFurnitureZone(line: ExtractedLine, page: ExtractedPage): boolean {
  if (page.height <= 0) {
    return false
  }
  const zone = page.height * FURNITURE_ZONE_RATIO
  return line.y + line.height >= page.height - zone || line.y <= zone
}

function furnitureKey(line: ExtractedLine, page: ExtractedPage): string | undefined {
  if (!inFurnitureZone(line, page)) {
    return undefined
  }
  const position = line.y >= page.height / 2 ? 'top' : 'bottom'
  const normalized = line.text.trim().replace(/\d+/g, '#')
  return `${position}:${Math.round(line.y / 10)}:${normalized}`
}
