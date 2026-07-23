#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { assembleBlocks } from './pipeline/assemble.js'
import { attachTableStructure, tablePageIndices } from './pipeline/enrich-tables.js'
import { extractPdf, readPdfInfo, readStructure } from './pipeline/ingest.js'
import { renderPdf } from './pipeline/render.js'
import { blocksFromStructure } from './pipeline/structure-blocks.js'
import { AppleTranslator } from './translator/apple-translator.js'
import { LlmTranslator } from './translator/llm-translator.js'
import { maskProtectedSpans, restoreProtectedSpans } from './pipeline/protect.js'
import type { Block } from './pipeline/assemble.types.js'
import type { Glossary } from './pipeline/protect.types.js'
import type { TranslationUnit, Translator } from './translator/translator.types.js'

interface CliOptions {
  inputPath: string
  outputPath: string
  sourceLanguage: string
  targetLanguage: string
  pageRange?: PageRange
  glossary: Glossary
  engine: 'apple' | 'gemini'
}

interface PageRange {
  first: number
  last: number
}

function parsePageRange(value: string | undefined): PageRange {
  const match = value?.match(/^(\d+)(?:-(\d+))?$/)
  if (match === null || match === undefined || match[1] === undefined) {
    console.error(`invalid --pages value: ${value} (expected N or N-M)`)
    process.exit(1)
  }
  const first = Number(match[1])
  const last = match[2] !== undefined ? Number(match[2]) : first
  if (first < 1 || last < first) {
    console.error(`invalid --pages range: ${value}`)
    process.exit(1)
  }
  return { first, last }
}

function parseArgs(argv: readonly string[]): CliOptions {
  let inputPath: string | undefined
  let outputPath: string | undefined
  let sourceLanguage = 'en'
  let targetLanguage = 'ko'
  let pageRange: PageRange | undefined
  let glossaryPath: string | undefined
  let engine = 'apple'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--output':
      case '-o':
        outputPath = argv[++i]
        break
      case '--pages':
        pageRange = parsePageRange(argv[++i])
        break
      case '--glossary':
        glossaryPath = argv[++i]
        break
      case '--engine':
        engine = argv[++i] ?? engine
        break
      case '--source':
        sourceLanguage = argv[++i] ?? sourceLanguage
        break
      case '--target':
        targetLanguage = argv[++i] ?? targetLanguage
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        if (arg !== undefined && !arg.startsWith('-') && inputPath === undefined) {
          inputPath = arg
        } else {
          console.error(`unknown argument: ${arg}`)
          process.exit(1)
        }
    }
  }

  if (inputPath === undefined) {
    printUsage()
    process.exit(1)
  }

  const resolvedOutput =
    outputPath ??
    path.join(
      path.dirname(inputPath),
      `${path.basename(inputPath, path.extname(inputPath))}.${targetLanguage}.pdf`
    )

  if (engine !== 'apple' && engine !== 'gemini') {
    console.error(`unknown engine: ${engine} (expected apple or gemini)`)
    process.exit(1)
  }

  return {
    inputPath,
    outputPath: resolvedOutput,
    sourceLanguage,
    targetLanguage,
    pageRange,
    glossary: loadGlossary(glossaryPath),
    engine,
  }
}

function makeTranslator(options: CliOptions, fromOcr: boolean): Translator {
  if (options.engine === 'gemini') {
    const apiKey = process.env['GEMINI_API_KEY']
    if (apiKey === undefined || apiKey.length === 0) {
      console.error('--engine gemini requires the GEMINI_API_KEY environment variable')
      process.exit(1)
    }
    console.log('Using Gemini translation engine')
    return new LlmTranslator({ apiKey, fromOcr })
  }
  return new AppleTranslator()
}

// 각 블록에 대해, 그 앞에 나온 가장 최근 헤딩 텍스트를 매핑한다. 컨텍스트
// 배치 번역에서 짧은 본문/헤딩을 소속 섹션과 함께 판단하는 데 쓰인다.
function sectionByBlock(blocks: readonly Block[]): string[] {
  const sections: string[] = []
  let current = ''
  for (const block of blocks) {
    sections.push(current)
    if (block.type === 'heading') {
      current = block.text
    }
  }
  return sections
}

function loadGlossary(glossaryPath: string | undefined): Glossary {
  if (glossaryPath === undefined) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(glossaryPath, 'utf8')) as Glossary
  } catch (error) {
    console.error(
      `cannot load glossary ${glossaryPath}: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  }
}

interface BuildBlocksResult {
  blocks: Block[]
  usedOcr: boolean
}

async function buildBlocks(options: CliOptions, ocrLanguages: string[]): Promise<BuildBlocksResult> {
  const info = await readPdfInfo(options.inputPath)

  if (info.hasTextLayer) {
    const ingested = await extractPdf(options.inputPath)
    console.log(`Extracted ${ingested.pageCount} page(s)`)
    let pages = ingested.pages
    if (options.pageRange !== undefined) {
      pages = pages.slice(options.pageRange.first - 1, options.pageRange.last)
      console.log(`Limited to page(s) ${options.pageRange.first}-${options.pageRange.last}`)
    }
    const blocks = assembleBlocks(pages, ingested.pages)

    const tablePages = tablePageIndices(blocks)
    if (tablePages.length > 0) {
      console.log(`Detecting table structure on ${tablePages.length} page(s)`)
      const structure = await readStructure(options.inputPath, ocrLanguages, tablePages)
      const matched = attachTableStructure(blocks, structure)
      console.log(`Matched cell structure for ${matched} table(s)`)
    }
    return { blocks, usedOcr: false }
  }

  console.log('No text layer found — running document structure recognition')
  const structure = await readStructure(options.inputPath, ocrLanguages)
  let structuredPages = structure.pages
  if (options.pageRange !== undefined) {
    const { first, last } = options.pageRange
    structuredPages = structuredPages.filter(
      (page) => page.index >= first - 1 && page.index <= last - 1
    )
    console.log(`Limited to page(s) ${first}-${last}`)
  }
  return { blocks: blocksFromStructure(structuredPages), usedOcr: true }
}

const VISION_LANGUAGES: Record<string, string> = {
  en: 'en-US',
  ko: 'ko-KR',
}

function toVisionLanguage(language: string): string {
  return VISION_LANGUAGES[language] ?? language
}

function printUsage(): void {
  console.log(
    `usage: pdf-translator <input.pdf> [-o output.pdf] [--source en] [--target ko] ` +
      `[--pages N[-M]] [--glossary terms.json] [--engine apple|gemini]`
  )
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.engine === 'gemini' && !process.env['GEMINI_API_KEY']) {
    console.error('--engine gemini requires the GEMINI_API_KEY environment variable')
    process.exit(1)
  }

  console.log(`Reading ${options.inputPath}`)
  const ocrLanguages = [options.sourceLanguage, options.targetLanguage].map(toVisionLanguage)
  const { blocks, usedOcr } = await buildBlocks(options, ocrLanguages)
  const headingCount = blocks.filter((block) => block.type === 'heading').length
  console.log(`Assembled ${blocks.length} block(s) (${headingCount} heading(s))`)

  const translatable = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type !== 'table')
  const tableCount = blocks.length - translatable.length

  const cellRefs: Array<{ rows: string[][]; row: number; column: number }> = []
  for (const block of blocks) {
    if (block.type !== 'table' || block.rows === undefined) {
      continue
    }
    block.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (/[A-Za-z]{3,}/.test(cell)) {
          cellRefs.push({ rows: block.rows as string[][], row: rowIndex, column: columnIndex })
        }
      })
    })
  }
  if (tableCount > 0) {
    console.log(`Tables: ${tableCount} block(s), translating ${cellRefs.length} text cell(s)`)
  }

  const translator = makeTranslator(options, usedOcr)
  const texts = [
    ...translatable.map(({ block }) => block.text),
    ...cellRefs.map(({ rows, row, column }) => rows[row]?.[column] ?? ''),
  ]

  // gemini는 용어집을 in-prompt 지시문으로 받아 문맥에 맞게 활용하므로 마스킹하지
  // 않는다. apple(세그먼트 단위 NMT)은 기존대로 토큰 치환으로 용어를 고정한다.
  const inPromptGlossary = options.engine === 'gemini'
  const { masked, tokens } = maskProtectedSpans(texts, options.glossary, {
    maskGlossary: !inPromptGlossary,
  })
  if (tokens.size > 0) {
    const kinds = inPromptGlossary ? 'URLs, emails' : 'URLs, emails, glossary terms'
    console.log(`Protected ${tokens.size} span(s) (${kinds})`)
  }

  const sections = sectionByBlock(blocks)
  const units: TranslationUnit[] = [
    ...translatable.map(({ block, index }, position) => ({
      text: masked[position] ?? block.text,
      kind: block.type === 'heading' ? ('heading' as const) : ('body' as const),
      section: sections[index] || undefined,
      page: block.source?.page,
    })),
    ...cellRefs.map((_, offset) => ({
      text: masked[translatable.length + offset] ?? '',
      kind: 'cell' as const,
    })),
  ]

  const translated = await translator.translate(units, {
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    glossary: inPromptGlossary ? options.glossary : undefined,
    onProgress: (completed, total) => {
      console.log(`Translated ${completed}/${total} block(s)`)
    },
  })
  const restored = restoreProtectedSpans(translated, tokens)

  const translatedBlocks: Block[] = blocks.map((block) => ({
    ...block,
    rows: block.rows?.map((row) => [...row]),
  }))
  translatable.forEach(({ index }, position) => {
    const block = translatedBlocks[index]
    if (block !== undefined && restored[position] !== undefined) {
      block.text = restored[position]
    }
  })
  cellRefs.forEach(({ rows, row, column }, offset) => {
    const value = restored[translatable.length + offset]
    if (value !== undefined) {
      const originalIndex = blocks.findIndex((block) => block.rows === rows)
      const target = translatedBlocks[originalIndex]?.rows
      if (target?.[row] !== undefined) {
        target[row][column] = value
      }
    }
  })

  const rendered = await renderPdf(translatedBlocks, options.outputPath)
  console.log(`Wrote ${rendered.output} (${rendered.pageCount} page(s))`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
