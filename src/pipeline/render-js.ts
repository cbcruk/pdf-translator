import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { Block } from './assemble.types.js'
import type { RenderResult } from './render.js'

// Swift(Core Graphics) 렌더러의 지표를 그대로 옮긴다 — Letter 612×792, 64pt 여백.
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 64
const TEXT_WIDTH = PAGE_WIDTH - MARGIN * 2
const BLACK = rgb(0, 0, 0)
const GRID = rgb(0.55, 0.55, 0.55)

const BODY = { size: 11, lineHeight: 1.3, before: 0, after: 9 }
const HEADING = { size: 16, lineHeight: 1.3, before: 16, after: 10 }
const TABLE = { size: 9, lineHeight: 1.15, padX: 5, padY: 3 }

/** fontkit로 임베딩 가능한 단일 CJK 폰트(.otf/.ttf) 후보 경로. .ttc는 fontkit 임베딩 불가라 제외. */
const FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf',
  '/Library/Fonts/NotoSansKR-Regular.otf',
  '/Library/Fonts/NotoSansCJKkr-Regular.otf',
]

export interface JsRenderOptions {
  /** 한글을 그리려면 필요한 CJK 폰트(.otf/.ttf) 경로. 미지정 시 env·후보 경로에서 탐색. */
  fontPath?: string
}

/**
 * pdf-lib(순수 JS) 기반 렌더러. Swift/Core Graphics `pdf-cli render`의 크로스플랫폼 대체
 * 백엔드로, 같은 블록 배열을 받아 리플로우 PDF를 만든다. 한글 출력에는 fontkit로 임베딩 가능한
 * CJK 폰트가 필요하며(서브셋 임베딩), 해석에 실패하면 Helvetica로 폴백한다(WinAnsi 전용 — 그릴
 * 수 없는 문자가 있으면 명확한 오류로 안내). Swift 툴체인 없이 도는 완전 JS 경로를 실험하는 스파이크다.
 */
export async function renderPdfWithJs(
  blocks: readonly Block[],
  outputPath: string,
  options: JsRenderOptions = {}
): Promise<RenderResult> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)

  const fontPath = resolveFontPath(options.fontPath)
  let body: PDFFont
  let heading: PDFFont
  if (fontPath !== undefined) {
    body = await doc.embedFont(readFileSync(fontPath), { subset: true })
    heading = body // 임베딩 CJK는 단일 웨이트 — 헤딩은 크기로 구분
  } else {
    body = await doc.embedFont(StandardFonts.Helvetica)
    heading = await doc.embedFont(StandardFonts.HelveticaBold)
    assertEncodable(body, blocks)
  }

  const renderer = new JsPdfRenderer(doc, { body, heading })
  for (const block of blocks) {
    if (block.type === 'table' && block.rows !== undefined) {
      renderer.drawTable(block.rows)
    } else if (block.type === 'table') {
      renderer.drawParagraph(block.text, body, TABLE.size, TABLE.lineHeight, 8, 8)
    } else if (block.type === 'heading') {
      renderer.drawParagraph(block.text, heading, HEADING.size, HEADING.lineHeight, HEADING.before, HEADING.after)
    } else {
      renderer.drawParagraph(block.text, body, BODY.size, BODY.lineHeight, BODY.before, BODY.after)
    }
  }

  const pageCount = renderer.pageCount
  const bytes = await doc.save()
  writeFileSync(outputPath, bytes)
  return { output: outputPath, pageCount: Math.max(pageCount, 1) }
}

class JsPdfRenderer {
  private readonly counter = { value: 0 }
  private page: PDFPage | undefined
  private cursorY = 0

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: { body: PDFFont; heading: PDFFont }
  ) {}

  get pageCount(): number {
    return this.counter.value
  }

  private newPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    this.counter.value += 1
    this.cursorY = PAGE_HEIGHT - MARGIN
  }

  private ensurePage(): PDFPage {
    if (this.page === undefined) {
      this.newPage()
    }
    return this.page as PDFPage
  }

  /** 문단/헤딩 한 블록을 그린다. 줄바꿈·페이지네이션·앞뒤 여백을 처리한다. */
  drawParagraph(
    text: string,
    font: PDFFont,
    size: number,
    lineHeight: number,
    spaceBefore: number,
    spaceAfter: number
  ): void {
    this.ensurePage()
    if (this.cursorY < PAGE_HEIGHT - MARGIN) {
      this.cursorY -= spaceBefore
    }
    const step = size * lineHeight
    for (const line of wrapText(text, font, size, TEXT_WIDTH)) {
      if (this.cursorY - step < MARGIN) {
        this.newPage()
      }
      this.ensurePage().drawText(line, { x: MARGIN, y: this.cursorY - size, size, font, color: BLACK })
      this.cursorY -= step
    }
    this.cursorY -= spaceAfter
  }

  /** 셀 텍스트를 격자(테두리+열 폭 자동+셀 내 줄바꿈)로 그린다. 행 단위로 페이지네이션한다. */
  drawTable(rows: readonly string[][]): void {
    if (rows.length === 0) {
      return
    }
    this.ensurePage()
    if (this.cursorY < PAGE_HEIGHT - MARGIN) {
      this.cursorY -= 10
    }
    const font = this.fonts.body
    const columnCount = Math.max(...rows.map((row) => row.length), 1)
    const normalized = rows.map((row) => [
      ...row,
      ...Array<string>(columnCount - row.length).fill(''),
    ])

    // 열 자연 폭 = 셀 한 줄 폭의 최대 + 좌우 패딩. 합이 본문 폭을 넘으면 비례 축소.
    const natural = Array<number>(columnCount).fill(12)
    normalized.forEach((row) => {
      row.forEach((cell, column) => {
        if (cell.length > 0) {
          const width = font.widthOfTextAtSize(cell, TABLE.size) + TABLE.padX * 2
          natural[column] = Math.max(natural[column] ?? 12, width)
        }
      })
    })
    const total = natural.reduce((sum, width) => sum + width, 0)
    const scale = total > TEXT_WIDTH ? TEXT_WIDTH / total : 1
    const widths = natural.map((width) => width * scale)
    const step = TABLE.size * TABLE.lineHeight

    for (const row of normalized) {
      const wrapped = row.map((cell, column) =>
        wrapText(cell, font, TABLE.size, (widths[column] ?? 0) - TABLE.padX * 2)
      )
      const rowHeight = Math.max(...wrapped.map((lines) => lines.length), 1) * step + TABLE.padY * 2

      if (this.cursorY - rowHeight < MARGIN) {
        this.newPage()
      }
      const top = this.cursorY
      const bottom = top - rowHeight
      const page = this.ensurePage()

      let x = MARGIN
      row.forEach((_, column) => {
        const width = widths[column] ?? 0
        page.drawRectangle({
          x,
          y: bottom,
          width,
          height: rowHeight,
          borderColor: GRID,
          borderWidth: 0.5,
        })
        wrapped[column]?.forEach((line, lineIndex) => {
          page.drawText(line, {
            x: x + TABLE.padX,
            y: top - TABLE.padY - TABLE.size - lineIndex * step,
            size: TABLE.size,
            font,
            color: BLACK,
          })
        })
        x += width
      })
      this.cursorY = bottom
    }
    this.cursorY -= 10
  }
}

/**
 * 텍스트를 폭 안에 맞게 줄바꿈한다. 공백 단위 greedy로 묶고, 한 낱말이 폭을 넘으면 글자 단위로
 * 쪼갠다(긴 URL·공백 없는 CJK 런 방어). 낱말 중간에는 인위적 공백을 넣지 않는다.
 */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    const commit = (word: string): void => {
      const candidate = line === '' ? word : `${line} ${word}`
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate
        return
      }
      if (line !== '') {
        lines.push(line)
        line = ''
      }
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word
        return
      }
      let chunk = ''
      for (const char of word) {
        const next = chunk + char
        if (chunk !== '' && font.widthOfTextAtSize(next, size) > maxWidth) {
          lines.push(chunk)
          chunk = char
        } else {
          chunk = next
        }
      }
      line = chunk
    }
    for (const word of paragraph.split(' ').filter((word) => word.length > 0)) {
      commit(word)
    }
    if (line !== '') {
      lines.push(line)
    }
  }
  return lines
}

/** 폰트 경로를 옵션 → env → 후보 경로 순으로 해석한다. 없으면 undefined(라틴 폴백). */
function resolveFontPath(explicit: string | undefined): string | undefined {
  const fromEnv = process.env['PDF_TRANSLATOR_FONT']
  for (const candidate of [explicit, fromEnv, ...FONT_CANDIDATES]) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * 폴백 Helvetica는 WinAnsi(CP1252)만 인코딩한다 — 스마트 따옴표·불릿·대시는 되지만 한글은
 * 안 된다. 실제 폰트로 인코딩을 시도해 그릴 수 없는 문자가 있으면 CJK 폰트 지정을 안내한다.
 */
function assertEncodable(font: PDFFont, blocks: readonly Block[]): void {
  for (const block of blocks) {
    const text = block.text + (block.rows?.flat().join(' ') ?? '')
    try {
      font.widthOfTextAtSize(text, BODY.size)
    } catch {
      throw new Error(
        'renderer=js needs a CJK font to draw non-Latin text. ' +
          'Provide --font <path-to.otf> or set PDF_TRANSLATOR_FONT ' +
          '(e.g. Noto Sans KR). Only .otf/.ttf single-file fonts are supported.'
      )
    }
  }
}
