import { runProcess } from '../utils/run-process.js'
import { resolveSwiftBinary } from '../utils/swift-binaries.js'
import type { IngestResult, PdfInfo, StructureResult } from './ingest.types.js'

export async function readPdfInfo(inputPath: string): Promise<PdfInfo> {
  const output = await runPdfCli(['info', inputPath])
  return JSON.parse(output) as PdfInfo
}

export async function extractPdf(inputPath: string): Promise<IngestResult> {
  const output = await runPdfCli(['extract', inputPath])
  return JSON.parse(output) as IngestResult
}

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

async function runPdfCli(args: readonly string[]): Promise<string> {
  const binary = resolveSwiftBinary('pdf-cli')
  const result = await runProcess(binary, args)
  if (result.exitCode !== 0) {
    throw new Error(`pdf-cli ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  return result.stdout
}
