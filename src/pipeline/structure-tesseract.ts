import { existsSync, readFileSync } from 'node:fs'
import Tesseract from 'tesseract.js'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'
import type { StructureResult, StructuredBox, StructuredPage } from './ingest.types.js'

/** 페이지를 래스터화할 배율. Vision 경로와 맞춰 3x(작은 글자 인식률). */
const DEFAULT_SCALE = 3
/** 우리 짧은 언어 코드 → tesseract traineddata 이름. */
const TESSERACT_LANGUAGES: Record<string, string> = { en: 'eng', ko: 'kor' }
/** 시스템에 tesseract가 설치된 경우의 흔한 traineddata 디렉터리. */
const TESSDATA_CANDIDATES = [
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
  '/opt/homebrew/share/tessdata',
  '/usr/local/share/tessdata',
]

export interface TesseractStructureOptions {
  /** 우리 언어 코드(en/ko …). 내부에서 tesseract 코드(eng/kor)로 변환한다. */
  languages?: readonly string[]
  /** 래스터화 배율 (기본 3). */
  scale?: number
  /** 이 페이지들(0-based)만 인식한다. 생략 시 전체 — OCR은 느리므로 범위 지정 권장. */
  pageIndices?: readonly number[]
  /** `<lang>.traineddata`가 든 로컬 디렉터리. 오프라인 실행에 필요(미지정 시 env·후보 경로 탐색). */
  tessdataPath?: string
}

/**
 * tesseract.js 기반 스캔 문서 구조 인식기. Vision `RecognizeDocumentsRequest`(`pdf-cli structure`)의
 * 크로스플랫폼 대체 백엔드로, 같은 {@link StructureResult} 계약을 만족한다. 페이지를 unpdf(PDF.js)로
 * 래스터화한 뒤 OCR해 문단(문단별 bbox·줄 수)을 얻어 {@link StructuredPage}로 매핑한다.
 * Swift/Vision 없이 도는 완전 JS 스캔 경로를 실험하는 스파이크다.
 *
 * 한계: tesseract는 표/리스트 구조를 분리하지 않으므로 `tables`/`lists`는 빈 배열이다(문단만).
 * 한글 등 출력에는 로컬 traineddata가 필요하다(오프라인 정체성에 맞춰 CDN 자동 다운로드에
 * 의존하지 않고 경로를 요구한다).
 */
export async function recognizeStructureWithTesseract(
  inputPath: string,
  options: TesseractStructureOptions = {}
): Promise<StructureResult> {
  const scale = options.scale ?? DEFAULT_SCALE
  const languages = (options.languages ?? ['en']).map(toTesseractLanguage)
  const tessdata = resolveTessdata(options.tessdataPath)
  const wanted = options.pageIndices !== undefined ? new Set(options.pageIndices) : undefined

  const data = new Uint8Array(readFileSync(inputPath))
  const pdf = await getDocumentProxy(data)
  const worker = await Tesseract.createWorker(languages.join('+'), 1, {
    langPath: tessdata,
    cachePath: tessdata,
    gzip: false,
  })

  try {
    const pages: StructuredPage[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const index = pageNumber - 1
      if (wanted !== undefined && !wanted.has(index)) {
        continue
      }
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const png = await renderPageAsImage(pdf, pageNumber, {
        canvasImport: () => import('@napi-rs/canvas'),
        scale,
      })
      const { data: recognized } = await worker.recognize(
        Buffer.from(png),
        {},
        { blocks: true }
      )
      pages.push(pageFromTesseract(recognized, index, viewport.width, viewport.height, scale))
    }
    return { pageCount: pdf.numPages, pages }
  } finally {
    await worker.terminate()
  }
}

/**
 * tesseract 인식 결과 한 페이지를 {@link StructuredPage}로 매핑한다(순수 함수). 블록→문단을 펼쳐
 * 각 문단을 `StructuredParagraph`로 만든다. 표/리스트는 tesseract가 분리하지 않으므로 빈 배열.
 *
 * @param widthPts 페이지 폭(포인트, 이미지 픽셀 아님)
 * @param heightPts 페이지 높이(포인트)
 * @param scale 래스터화 배율 — bbox를 픽셀에서 포인트로 되돌리는 데 쓴다
 */
export function pageFromTesseract(
  page: Tesseract.Page,
  index: number,
  widthPts: number,
  heightPts: number,
  scale: number
): StructuredPage {
  const paragraphs = []
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      if (paragraph.text.trim().length === 0) {
        continue
      }
      paragraphs.push({
        text: paragraph.text,
        box: bboxToBox(paragraph.bbox, heightPts, scale),
        lineCount: paragraph.lines.length,
      })
    }
  }
  return { index, width: widthPts, height: heightPts, title: null, paragraphs, tables: [], lists: [] }
}

/**
 * tesseract bbox(이미지 픽셀, 좌상단 원점, y 아래로 증가)를 {@link StructuredBox}(포인트,
 * 좌하단 원점)로 변환한다. y는 하단 모서리이며, `blocksFromStructure`가 `y+height`(상단)로
 * 읽기 순서를 잡는 규약과 맞는다.
 */
export function bboxToBox(
  bbox: Tesseract.Bbox,
  heightPts: number,
  scale: number
): StructuredBox {
  return {
    x: bbox.x0 / scale,
    y: heightPts - bbox.y1 / scale,
    width: (bbox.x1 - bbox.x0) / scale,
    height: (bbox.y1 - bbox.y0) / scale,
  }
}

function toTesseractLanguage(language: string): string {
  return TESSERACT_LANGUAGES[language] ?? language
}

/** traineddata 디렉터리를 옵션 → env → 후보 경로 순으로 해석한다. 없으면 안내와 함께 던진다. */
function resolveTessdata(explicit: string | undefined): string {
  const fromEnv = process.env['PDF_TRANSLATOR_TESSDATA']
  for (const candidate of [explicit, fromEnv, ...TESSDATA_CANDIDATES]) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    'ocr=tesseract needs local traineddata. Provide --tessdata <dir> or set ' +
      'PDF_TRANSLATOR_TESSDATA to a directory containing <lang>.traineddata ' +
      '(e.g. eng.traineddata, kor.traineddata from tessdata_fast/tessdata_best).'
  )
}
