import type { Glossary } from '../pipeline/protect.types.js'
import type { TranslationOptions, TranslationUnit, Translator } from './translator.types.js'

const DEFAULT_MODEL = 'gemini-flash-latest'
const MAX_BATCH = 20 // 한 요청에 담는 번역 단위 수
const CONCURRENCY = 4 // 동시 요청 수 (on-device와 달리 API는 병렬이 유효)
const CONTEXT_UNITS = 2 // 배치 앞에 참고용으로 붙이는 직전 소스 단위 수
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface LlmTranslatorConfig {
  apiKey: string
  model?: string
  fromOcr?: boolean
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
  }>
}

// 전역 units 배열에 대한 연속 구간. 컨텍스트는 이 구간 앞의 소스 텍스트에서
// 뽑으므로 배치끼리 의존성이 없고, 그래서 동시 실행이 안전하다.
interface Batch {
  indices: number[]
}

interface BatchContext {
  section?: string
  before: string[]
}

export class LlmTranslator implements Translator {
  private readonly apiKey: string
  private readonly model: string
  private readonly fromOcr: boolean

  constructor(config: LlmTranslatorConfig) {
    this.apiKey = config.apiKey
    this.model = config.model ?? DEFAULT_MODEL
    this.fromOcr = config.fromOcr ?? false
  }

  async translate(
    units: readonly TranslationUnit[],
    options: TranslationOptions
  ): Promise<string[]> {
    if (units.length === 0) {
      return []
    }

    const batches = planBatches(units)
    const results = new Array<string>(units.length)
    let completed = 0

    await mapPool(batches, CONCURRENCY, async (batch) => {
      const out = await this.translateBatch(batch, units, options)
      batch.indices.forEach((globalIndex, position) => {
        results[globalIndex] = out[position] ?? units[globalIndex]?.text ?? ''
      })
      completed += batch.indices.length
      options.onProgress?.(completed, units.length)
    })

    return results.map((value, index) => value ?? units[index]?.text ?? '')
  }

  // 실패(개수 불일치·API 오류) 시 배치를 반으로 쪼개 재시도하고, 끝내
  // 단일 단위도 실패하면 원문을 그대로 둔다 — 부분 실패가 전체를 죽이지 않게.
  private async translateBatch(
    batch: Batch,
    units: readonly TranslationUnit[],
    options: TranslationOptions
  ): Promise<string[]> {
    const items = batch.indices.map((index) => units[index]?.text ?? '')
    try {
      return await this.request(items, contextFor(units, batch), options)
    } catch (error) {
      if (batch.indices.length <= 1) {
        return items
      }
      const mid = Math.ceil(batch.indices.length / 2)
      const left: Batch = { indices: batch.indices.slice(0, mid) }
      const right: Batch = { indices: batch.indices.slice(mid) }
      const [leftOut, rightOut] = await Promise.all([
        this.translateBatch(left, units, options),
        this.translateBatch(right, units, options),
      ])
      return [...leftOut, ...rightOut]
    }
  }

  private async request(
    items: readonly string[],
    context: BatchContext,
    options: TranslationOptions
  ): Promise<string[]> {
    const prompt = this.buildPrompt(items, context, options)
    const response = await fetch(`${ENDPOINT}/${this.model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Gemini API error ${response.status}: ${detail.slice(0, 300)}`)
    }

    const payload = (await response.json()) as GeminiResponse
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text
    if (text === undefined) {
      throw new Error('Gemini API returned no candidates')
    }
    const parsed = parseJsonArray(text)
    if (!Array.isArray(parsed) || parsed.length !== items.length) {
      throw new Error(
        `Gemini returned ${Array.isArray(parsed) ? parsed.length : 'non-array'} items for ${items.length} inputs`
      )
    }
    return parsed.map((item, index) => (typeof item === 'string' ? item : (items[index] ?? '')))
  }

  private buildPrompt(
    items: readonly string[],
    context: BatchContext,
    options: TranslationOptions
  ): string {
    const lines = [
      `Translate each ${options.sourceLanguage} item in the TRANSLATE array below into ${options.targetLanguage}.`,
      'Rules:',
      `- Return ONLY a JSON array of ${items.length} translated strings, same length and order as TRANSLATE.`,
      '- The CONTEXT section is background for disambiguation only; do NOT translate it or include it in your output.',
      '- Preserve placeholder tokens like ⟦U0⟧ exactly as they appear.',
      '- Keep numbers, units, and proper nouns accurate; use consistent terminology across all items.',
      '- Use natural written style (문어체) appropriate for documents.',
    ]
    if (this.fromOcr) {
      lines.push(
        '- The source text came from OCR, so occasional character-level recognition errors are possible; translate the intended meaning.'
      )
    }
    const glossary = glossaryBlock(options.glossary)
    if (glossary !== undefined) {
      lines.push(glossary)
    }
    const contextBlock = contextLines(context)
    if (contextBlock !== undefined) {
      lines.push(`CONTEXT:\n${contextBlock}`)
    }
    lines.push(`TRANSLATE:\n${JSON.stringify(items)}`)
    return lines.join('\n')
  }
}

// 페이지 경계와 크기 상한에서 배치를 자른다. 헤딩은 별도로 떼지 않고
// 뒤 본문과 같은 배치에 두어 짧은 헤딩이 문맥과 함께 판단되도록 한다.
function planBatches(units: readonly TranslationUnit[]): Batch[] {
  const batches: Batch[] = []
  let current: number[] = []
  let currentPage: number | undefined

  const flush = (): void => {
    if (current.length > 0) {
      batches.push({ indices: current })
      current = []
    }
  }

  units.forEach((unit, index) => {
    const pageBreak =
      current.length > 0 &&
      unit.page !== undefined &&
      currentPage !== undefined &&
      unit.page !== currentPage
    if (current.length >= MAX_BATCH || pageBreak) {
      flush()
    }
    if (current.length === 0) {
      currentPage = unit.page
    }
    current.push(index)
  })
  flush()
  return batches
}

function contextFor(units: readonly TranslationUnit[], batch: Batch): BatchContext {
  const first = batch.indices[0] ?? 0
  const before: string[] = []
  for (let index = Math.max(0, first - CONTEXT_UNITS); index < first; index++) {
    const text = units[index]?.text
    if (text !== undefined && text.length > 0) {
      before.push(text)
    }
  }
  return { section: units[first]?.section, before }
}

function contextLines(context: BatchContext): string | undefined {
  const parts: string[] = []
  if (context.section !== undefined && context.section.length > 0) {
    parts.push(`Section heading: ${context.section}`)
  }
  if (context.before.length > 0) {
    parts.push(`Preceding text: ${context.before.join(' / ')}`)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function glossaryBlock(glossary: Glossary | undefined): string | undefined {
  if (glossary === undefined) {
    return undefined
  }
  const entries = Object.entries(glossary)
  if (entries.length === 0) {
    return undefined
  }
  return (
    'Use these exact target translations for the following terms (inflect naturally as needed):\n' +
    entries.map(([term, replacement]) => `- ${term} → ${replacement}`).join('\n')
  )
}

// responseMimeType으로 순수 JSON을 받지만, 모델이 코드펜스로 감싸는
// 경우를 대비해 벗겨낸 뒤 파싱한다.
function parseJsonArray(text: string): unknown {
  let trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    trimmed = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()
  }
  return JSON.parse(trimmed)
}

// 동시 실행 개수를 limit으로 제한하는 작업 풀.
async function mapPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) {
        return
      }
      const item = items[index]
      if (item !== undefined) {
        await worker(item, index)
      }
    }
  })
  await Promise.all(runners)
}
