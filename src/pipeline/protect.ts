import type { Glossary, ProtectedSpans } from './protect.types.js'

const URL_PATTERN = /(https?:\/\/|www\.)[^\s"'”„<>()\[\]{}]+/g
const BARE_DOMAIN_PATTERN =
  /\b[a-z0-9][\w-]*(\.[a-z0-9][\w-]*)*\.(com|org|net|edu|gov|io|app|dev|link|me|co|kr|jp|uk|de|fr)\b(\/[^\s"'”„<>()\[\]{}]*)?/gi
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

// 번역 엔진이 그대로 통과시키는 것을 실측으로 확인한 토큰 형식 (⟦U0⟧)
function tokenFor(index: number): string {
  return `⟦U${index}⟧`
}

export function maskProtectedSpans(
  texts: readonly string[],
  glossary: Glossary = {}
): ProtectedSpans {
  const tokens = new Map<string, string>()
  let counter = 0

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

  const glossaryPatterns = Object.entries(glossary).map(([term, replacement]) => ({
    pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'),
    replacement,
  }))

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

export function restoreProtectedSpans(
  texts: readonly string[],
  tokens: ReadonlyMap<string, string>
): string[] {
  return texts.map((text) =>
    text.replace(/⟦U\d+⟧/g, (token) => tokens.get(token) ?? token)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
