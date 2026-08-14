import { readFileSync } from 'node:fs'
import { extractTextItems, getDocumentProxy, type StructuredTextItem } from 'unpdf'
import type { ExtractedLine, ExtractedPage, IngestResult } from './ingest.types.js'

/**
 * 같은 줄로 묶을 baseline(y) 허용 오차를 폰트 크기 대비 비율로 정한다. 이 비율을 넘게
 * y가 튀면 hasEOL이 없어도 줄을 끊는다 (잘못 배치된 EOL 마커 방어).
 */
const LINE_Y_TOLERANCE_RATIO = 0.5

/**
 * unpdf(PDF.js) 기반 텍스트 레이어 추출기. `pdf-cli extract`(Swift/PDFKit)의 대체 백엔드로,
 * 같은 {@link IngestResult} 계약을 만족하도록 PDF.js 텍스트 항목을 줄 단위로 재조립한다.
 * Swift 툴체인 없이 모든 JS 런타임에서 도는 크로스플랫폼 추출 경로를 실험하기 위한 스파이크다.
 *
 * 한계: PDF.js/unpdf는 폰트 굵기를 노출하지 않아(fontFamily가 "sans-serif"류 제네릭으로
 * 뭉개짐) `bold`는 항상 false다. 큰 폰트 기반 헤딩 감지는 유지되지만, 본문 크기의 볼드-only
 * 헤딩은 놓친다. OCR·표 구조·페이지 크기 외 레이아웃은 제공하지 않는다.
 */
export async function extractPdfWithPdfjs(inputPath: string): Promise<IngestResult> {
  const data = new Uint8Array(readFileSync(inputPath))
  // getDocumentProxy로 한 번만 파싱하고, extractTextItems가 이 프록시를 재사용한다
  // (withDocument가 isPDFDocumentProxy로 판별해 재파싱하지 않음).
  const pdf = await getDocumentProxy(data)
  const { items } = await extractTextItems(pdf)

  const pages: ExtractedPage[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const pageItems = items[pageNumber - 1] ?? []
    pages.push({
      index: pageNumber - 1,
      width: viewport.width,
      height: viewport.height,
      lines: groupItemsIntoLines(pageItems),
    })
  }
  return { pageCount: pdf.numPages, pages }
}

/**
 * PDF.js 텍스트 항목(문자 런)을 줄로 묶는다. PDFKit이 공짜로 해주던 줄 그룹핑을 대신한다.
 * `hasEOL`을 1차 신호로, baseline(y)의 급변을 2차 가드로 사용한다. 빈/공백뿐인 항목은 줄바꿈
 * 신호로만 쓰이고 텍스트에는 기여하지 않는다.
 */
export function groupItemsIntoLines(items: readonly StructuredTextItem[]): ExtractedLine[] {
  const lines: ExtractedLine[] = []
  let current: StructuredTextItem[] = []

  const flush = (): void => {
    const line = lineFromItems(current)
    if (line !== undefined) {
      lines.push(line)
    }
    current = []
  }

  for (const item of items) {
    const first = current[0]
    if (first !== undefined) {
      const tolerance = Math.max(first.fontSize, item.fontSize) * LINE_Y_TOLERANCE_RATIO
      if (Math.abs(item.y - first.y) > tolerance) {
        flush()
      }
    }
    current.push(item)
    if (item.hasEOL) {
      flush()
    }
  }
  flush()

  return lines
}

/**
 * 한 줄을 이루는 항목들을 {@link ExtractedLine}으로 합친다. 텍스트가 비면 undefined
 * (줄바꿈 전용 EOL 마커 등). bbox는 실제 글자를 가진 항목에서, fontSize는 그중 글자 수가
 * 가장 많은 항목에서 취해 본문 크기가 헤딩 판정 통계에 반영되게 한다.
 */
function lineFromItems(items: readonly StructuredTextItem[]): ExtractedLine | undefined {
  if (items.length === 0) {
    return undefined
  }
  const text = items
    .map((item) => item.str)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) {
    return undefined
  }

  const glyphs = items.filter((item) => item.str.trim().length > 0)
  const source = glyphs.length > 0 ? glyphs : items
  const minX = Math.min(...source.map((item) => item.x))
  const maxX = Math.max(...source.map((item) => item.x + item.width))
  const y = Math.min(...source.map((item) => item.y))
  const height = Math.max(...source.map((item) => item.height))
  const dominant = source.reduce((best, item) =>
    item.str.length > best.str.length ? item : best
  )

  return {
    text,
    fontSize: dominant.fontSize,
    // unpdf는 폰트 굵기를 노출하지 않는다 — 위 함수 JSDoc의 한계 참고.
    bold: false,
    x: minX,
    y,
    width: maxX - minX,
    height: height > 0 ? height : dominant.fontSize,
  }
}
