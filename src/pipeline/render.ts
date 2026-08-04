import { runProcess } from '../utils/run-process.js'
import { resolveSwiftBinary } from '../utils/swift-binaries.js'
import type { Block } from './assemble.types.js'

/** `pdf-cli render`의 결과: 실제로 쓰인 출력 경로와 만들어진 페이지 수. */
export interface RenderResult {
  output: string
  pageCount: number
}

/**
 * 번역된 블록들을 `pdf-cli render`에 넘겨 새 PDF로 조판한다. 블록 배열을 stdin으로
 * JSON 전달하며, 렌더러가 블록 단위 레이아웃·표 그리드·페이지네이션을 처리한다.
 *
 * @param blocks 번역이 채워진 블록들 (읽기 순서)
 * @param outputPath 결과 PDF를 쓸 경로
 */
export async function renderPdf(
  blocks: readonly Block[],
  outputPath: string
): Promise<RenderResult> {
  const binary = resolveSwiftBinary('pdf-cli')
  const result = await runProcess(
    binary,
    ['render', '--output', outputPath],
    JSON.stringify({ blocks })
  )
  if (result.exitCode !== 0) {
    throw new Error(`pdf-cli render failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout) as RenderResult
}
