import type { Glossary } from '../pipeline/protect.types.js'

/**
 * 번역 단위. text 외에 구조 메타데이터를 실어, 컨텍스트 인식 배치가 가능한 엔진(gemini)이
 * 활용한다. Apple 경로는 text만 사용한다.
 */
export interface TranslationUnit {
  text: string
  /** 블록 종류. gemini 배치가 셀을 본문과 섞지 않게 하는 등에 쓰인다. */
  kind: 'heading' | 'body' | 'cell'
  /** 소속 섹션 헤딩. 배치의 컨텍스트로 실려 짧은 세그먼트를 문맥과 함께 판단하게 한다. */
  section?: string
  /** 0-based 페이지 인덱스. 배치를 페이지 경계에서 자르는 데 쓰인다. */
  page?: number
}

/** 모든 번역 엔진이 공유하는 번역 요청 옵션. */
export interface TranslationOptions {
  sourceLanguage: string
  targetLanguage: string
  /** in-prompt으로 전달할 용어집. 지정 시 엔진이 프롬프트 지시문으로 활용한다 (gemini 경로). */
  glossary?: Glossary
  /** 진행 콜백. (완료 단위 수, 전체 단위 수). */
  onProgress?: (completed: number, total: number) => void
}

/**
 * 번역 엔진 이음매. 구현체(Apple on-device / Gemini)를 JSON 계약처럼 갈아끼울 수 있다.
 * 반환 배열은 입력 units와 같은 길이·순서를 보장한다.
 */
export interface Translator {
  translate(units: readonly TranslationUnit[], options: TranslationOptions): Promise<string[]>
}
