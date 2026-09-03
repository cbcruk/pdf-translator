import { SwiftCliError } from '@cbcruk/swift-bridge'
import { TranslateExitCode, translate } from '@cbcruk/translate-cli'
import type { TranslationOptions, TranslationUnit, Translator } from './translator.types.js'

/** 한 번의 translate-cli 호출에 넘기는 단위 수. */
const CHUNK_SIZE = 12

/**
 * Apple on-device 번역 엔진. `@cbcruk/translate-cli`가 청크 분할·순서 보정·개수 검사를
 * 맡고, 여기서는 번역 단위를 텍스트로 펴서 넘긴다. on-device NMT은 세그먼트 단위라
 * 구조 메타데이터(section·page)를 활용하지 못하므로 각 단위의 text만 쓴다.
 */
export class AppleTranslator implements Translator {
  /** @returns units와 같은 순서의 번역문 배열 */
  async translate(
    units: readonly TranslationUnit[],
    options: TranslationOptions
  ): Promise<string[]> {
    try {
      return await translate(
        units.map((unit) => unit.text),
        {
          source: options.sourceLanguage,
          target: options.targetLanguage,
          chunkSize: CHUNK_SIZE,
          onProgress: options.onProgress,
        }
      )
    } catch (error) {
      if (
        error instanceof SwiftCliError &&
        error.exitCode === TranslateExitCode.languagePackMissing
      ) {
        throw new Error(
          `${options.sourceLanguage}→${options.targetLanguage} language pack is not installed. ` +
            'Install it in System Settings > General > Language & Region > Translation Languages.'
        )
      }
      throw error
    }
  }
}
