/** 마스킹 결과. masked를 번역에 넘기고, 번역 후 tokens로 복원한다. */
export interface ProtectedSpans {
  /** `⟦U0⟧` 형태의 토큰으로 보호 구간이 치환된 텍스트. */
  masked: string[]
  /** 토큰 → 복원할 원본 문자열 (URL·이메일은 원문, glossary는 지정 번역어). */
  tokens: Map<string, string>
}

/** 용어집: 원문 용어 → 고정 번역어. 예: `{ "sub-threshold": "서브 임계" }` */
export type Glossary = Record<string, string>
