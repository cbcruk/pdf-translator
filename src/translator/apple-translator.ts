import { runProcess } from '../utils/run-process.js'
import { resolveSwiftBinary } from '../utils/swift-binaries.js'
import type { TranslationOptions, TranslationUnit, Translator } from './translator.types.js'

/** translate-cli가 NDJSON 한 줄로 돌려주는 번역 결과. */
interface TranslatedLine {
  index: number
  sourceText: string
  targetText: string
}

/** 한 번의 translate-cli 호출에 넘기는 단위 수. */
const CHUNK_SIZE = 12

/**
 * Apple on-device 번역 엔진. `translate-cli`(Swift)를 청크 단위로 호출한다. on-device NMT은
 * 세그먼트 단위라 구조 메타데이터(section·page)를 활용하지 못하므로 각 단위의 text만 쓴다.
 * 시스템 데몬 수준에서 직렬화되므로 병렬화 이득이 없어 청크를 순차로 처리한다.
 */
export class AppleTranslator implements Translator {
  /** @returns units와 같은 순서의 번역문 배열 */
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

/** translate-cli의 NDJSON stdout을 한 줄씩 파싱한다 (빈 줄은 건너뛴다). */
function parseNdjson(output: string): TranslatedLine[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranslatedLine)
}
