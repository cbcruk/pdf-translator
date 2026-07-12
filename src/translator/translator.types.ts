export interface TranslationOptions {
  sourceLanguage: string
  targetLanguage: string
  onProgress?: (completed: number, total: number) => void
}

export interface Translator {
  translate(paragraphs: readonly string[], options: TranslationOptions): Promise<string[]>
}
