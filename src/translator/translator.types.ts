import type { Glossary } from '../pipeline/protect.types.js'

// 번역 단위. text 외에 구조 메타데이터를 실어, 컨텍스트 인식 배치가
// 가능한 엔진(gemini)이 활용한다. Apple 경로는 text만 사용한다.
export interface TranslationUnit {
  text: string
  kind: 'heading' | 'body' | 'cell'
  section?: string
  page?: number
}

export interface TranslationOptions {
  sourceLanguage: string
  targetLanguage: string
  // in-prompt으로 전달할 용어집. 지정 시 엔진이 프롬프트 지시문으로 활용한다.
  glossary?: Glossary
  onProgress?: (completed: number, total: number) => void
}

export interface Translator {
  translate(units: readonly TranslationUnit[], options: TranslationOptions): Promise<string[]>
}
