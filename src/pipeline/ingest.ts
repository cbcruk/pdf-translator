import { runProcess } from '../utils/run-process.js'
import { resolveSwiftBinary } from '../utils/swift-binaries.js'
import type { IngestResult, PdfInfo, StructureResult } from './ingest.types.js'

/** 페이지 수와 텍스트 레이어 유무를 조회한다 (추출/스캔 경로 분기의 근거). */
export async function readPdfInfo(inputPath: string): Promise<PdfInfo> {
  const output = await runPdfCli(['info', inputPath])
  return JSON.parse(output) as PdfInfo
}

/** PDFKit로 페이지별 줄 텍스트와 bbox·폰트 정보를 뽑는다 (텍스트 레이어 경로). */
export async function extractPdf(inputPath: string): Promise<IngestResult> {
  const output = await runPdfCli(['extract', inputPath])
  return JSON.parse(output) as IngestResult
}

/**
 * Vision `RecognizeDocumentsRequest`로 문단/제목/표/리스트 구조를 인식한다.
 * 스캔 경로 전체, 그리고 텍스트 경로에서 표가 있는 페이지에만 선택적으로 쓰인다.
 *
 * @param languages 인식 언어 우선순위 (예: `['ko-KR', 'en-US']`)
 * @param pageIndices 지정 시 해당 페이지만 인식한다 (표 페이지 한정 실행 등). 생략 시 전체.
 */
export async function readStructure(
  inputPath: string,
  languages: readonly string[],
  pageIndices?: readonly number[]
): Promise<StructureResult> {
  const args = ['structure', inputPath, '--languages', languages.join(',')]
  if (pageIndices !== undefined && pageIndices.length > 0) {
    args.push('--pages', pageIndices.join(','))
  }
  const output = await runPdfCli(args)
  return JSON.parse(output) as StructureResult
}

/** pdf-cli 서브커맨드를 실행하고 stdout을 돌려준다. 0이 아닌 종료 코드는 stderr를 담아 던진다. */
async function runPdfCli(args: readonly string[]): Promise<string> {
  const binary = resolveSwiftBinary('pdf-cli')
  const result = await runProcess(binary, args)
  if (result.exitCode !== 0) {
    throw new Error(`pdf-cli ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  return result.stdout
}
