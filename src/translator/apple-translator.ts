import { runProcess } from '../utils/run-process.js'
import { resolveSwiftBinary } from '../utils/swift-binaries.js'
import type { TranslationOptions, TranslationUnit, Translator } from './translator.types.js'

interface TranslatedLine {
  index: number
  sourceText: string
  targetText: string
}

const CHUNK_SIZE = 12

// on-device NMT은 세그먼트 단위라 구조 메타데이터를 활용하지 못한다. text만 사용한다.
export class AppleTranslator implements Translator {
  async translate(
    units: readonly TranslationUnit[],
    options: TranslationOptions
  ): Promise<string[]> {
    if (units.length === 0) {
      return []
    }
    const paragraphs = units.map((unit) => unit.text)

    const binary = resolveSwiftBinary('translate-cli')
    const args = ['--source', options.sourceLanguage, '--target', options.targetLanguage]
    const translated: string[] = []

    for (let offset = 0; offset < paragraphs.length; offset += CHUNK_SIZE) {
      const chunk = paragraphs.slice(offset, offset + CHUNK_SIZE)
      const result = await runProcess(binary, args, JSON.stringify(chunk))
      if (result.exitCode !== 0) {
        throw new Error(
          `translate-cli failed (exit ${result.exitCode}): ${result.stderr.trim()}`
        )
      }

      const lines = parseNdjson(result.stdout)
      if (lines.length !== chunk.length) {
        throw new Error(
          `translate-cli returned ${lines.length} results for ${chunk.length} inputs`
        )
      }
      lines.sort((a, b) => a.index - b.index)
      translated.push(...lines.map((line) => line.targetText))
      options.onProgress?.(translated.length, paragraphs.length)
    }

    return translated
  }
}

function parseNdjson(output: string): TranslatedLine[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranslatedLine)
}
