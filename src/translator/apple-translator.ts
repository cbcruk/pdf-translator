import { runProcess } from '../utils/run-process.js'
import { resolveSwiftBinary } from '../utils/swift-binaries.js'
import type { TranslationOptions, Translator } from './translator.types.js'

interface TranslatedLine {
  index: number
  sourceText: string
  targetText: string
}

const CHUNK_SIZE = 12

export class AppleTranslator implements Translator {
  async translate(
    paragraphs: readonly string[],
    options: TranslationOptions
  ): Promise<string[]> {
    if (paragraphs.length === 0) {
      return []
    }

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
