import type { TranslationOptions, Translator } from './translator.types.js'

const DEFAULT_MODEL = 'gemini-flash-latest'
const CHUNK_SIZE = 20
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
    paragraphs: readonly string[],
    options: TranslationOptions
  ): Promise<string[]> {
    const translated: string[] = []
    for (let offset = 0; offset < paragraphs.length; offset += CHUNK_SIZE) {
      const chunk = paragraphs.slice(offset, offset + CHUNK_SIZE)
      translated.push(...(await this.translateChunk(chunk, options)))
      options.onProgress?.(translated.length, paragraphs.length)
    }
    return translated
  }

  private async translateChunk(
    chunk: readonly string[],
    options: TranslationOptions
  ): Promise<string[]> {
    const prompt = this.buildPrompt(chunk, options)
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
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.length !== chunk.length) {
      throw new Error(
        `Gemini returned ${Array.isArray(parsed) ? parsed.length : 'non-array'} items for ${chunk.length} inputs`
      )
    }
    return parsed.map((item, index) => (typeof item === 'string' ? item : (chunk[index] ?? '')))
  }

  private buildPrompt(chunk: readonly string[], options: TranslationOptions): string {
    const ocrNote = this.fromOcr
      ? '- The source text came from OCR, so occasional character-level recognition errors are possible; translate the intended meaning.\n'
      : ''
    return (
      `Translate each ${options.sourceLanguage} paragraph in the JSON array below into ${options.targetLanguage}.\n` +
      'Rules:\n' +
      '- Return ONLY a JSON array of translated strings, same length and order as the input.\n' +
      '- Preserve placeholder tokens like ⟦U0⟧ exactly as they appear.\n' +
      '- Keep numbers, units, and proper nouns accurate; use consistent terminology across all paragraphs.\n' +
      '- Use natural written style (문어체) appropriate for documents.\n' +
      ocrNote +
      `Input:\n${JSON.stringify(chunk)}`
    )
  }
}
