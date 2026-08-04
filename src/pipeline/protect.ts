import type { Glossary, ProtectedSpans } from './protect.types.js'

/** `http(s)://` 또는 `www.`로 시작하는 URL. */
const URL_PATTERN = /(https?:\/\/|www\.)[^\s"'”„<>()\[\]{}]+/g
/** 프로토콜 없이 알려진 TLD로 끝나는 맨 도메인 (예: `example.com/path`). */
const BARE_DOMAIN_PATTERN =
  /\b[a-z0-9][\w-]*(\.[a-z0-9][\w-]*)*\.(com|org|net|edu|gov|io|app|dev|link|me|co|kr|jp|uk|de|fr)\b(\/[^\s"'”„<>()\[\]{}]*)?/gi
/** 이메일 주소. */
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
/** 매치 끝에 붙은 문장부호. 토큰과 분리해 원래 자리에 남겨 둔다. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

/** 인덱스로 보호 토큰을 만든다. 번역 엔진이 그대로 통과시키는 것을 실측으로 확인한 형식(⟦U0⟧). */
function tokenFor(index: number): string {
  return `⟦U${index}⟧`
}

export interface MaskOptions {
  /**
   * false면 glossary 용어를 토큰으로 치환하지 않는다. gemini 경로는 용어집을 in-prompt
   * 지시문으로 넘겨 모델이 문맥에 맞게 활용하도록 하므로 마스킹을 끈다. 기본값 true(Apple 경로).
   */
  maskGlossary?: boolean
}

/**
 * 번역 중 손상되면 안 되는 구간(URL·이메일·맨 도메인, 그리고 선택적으로 glossary 용어)을
 * `⟦U0⟧` 토큰으로 치환한다. 번역 후 {@link restoreProtectedSpans}로 되돌린다.
 * URL·이메일은 원문 그대로, glossary는 지정 번역어로 복원되도록 토큰 맵에 기록한다.
 * 끝에 붙은 문장부호는 토큰에서 떼어 제자리에 남긴다.
 *
 * @param glossary 원문 용어 → 고정 번역어
 * @returns 마스킹된 텍스트들과 복원용 토큰 맵
 */
export function maskProtectedSpans(
  texts: readonly string[],
  glossary: Glossary = {},
  { maskGlossary = true }: MaskOptions = {}
): ProtectedSpans {
  const tokens = new Map<string, string>()
  let counter = 0

  // pattern 매치를 토큰으로 바꾸고, resolve(매치)를 복원값으로 토큰 맵에 등록한다.
  const mask = (text: string, pattern: RegExp, resolve: (match: string) => string): string =>
    text.replace(pattern, (match) => {
      const trailing = match.match(TRAILING_PUNCTUATION)?.[0] ?? ''
      const span = trailing.length > 0 ? match.slice(0, -trailing.length) : match
      if (span.length === 0) {
        return match
      }
      const token = tokenFor(counter++)
      tokens.set(token, resolve(span))
      return token + trailing
    })

  const glossaryPatterns = maskGlossary
    ? Object.entries(glossary).map(([term, replacement]) => ({
        pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'),
        replacement,
      }))
    : []

  const masked = texts.map((text) => {
    let result = mask(text, URL_PATTERN, (span) => span)
    result = mask(result, EMAIL_PATTERN, (span) => span)
    result = mask(result, BARE_DOMAIN_PATTERN, (span) => span)
    for (const { pattern, replacement } of glossaryPatterns) {
      result = mask(result, pattern, () => replacement)
    }
    return result
  })

  return { masked, tokens }
}

/**
 * {@link maskProtectedSpans}가 심은 `⟦U0⟧` 토큰을 번역 결과에서 원래(또는 지정) 문자열로
 * 되돌린다. 맵에 없는 토큰은 그대로 둔다.
 */
export function restoreProtectedSpans(
  texts: readonly string[],
  tokens: ReadonlyMap<string, string>
): string[] {
  return texts.map((text) =>
    text.replace(/⟦U\d+⟧/g, (token) => tokens.get(token) ?? token)
  )
}

/** 정규식 특수문자를 이스케이프해 glossary 용어를 리터럴로 매칭할 수 있게 한다. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
