import { runProcess } from '../utils/run-process.js'
import { resolveSwiftBinary } from '../utils/swift-binaries.js'
import type { Block } from './assemble.types.js'

export interface RenderResult {
  output: string
  pageCount: number
}

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
