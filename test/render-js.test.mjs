import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractText, getDocumentProxy } from 'unpdf'
import { assembleBlocks } from '../dist/pipeline/assemble.js'
import { extractPdfWithPdfjs } from '../dist/pipeline/extract-pdfjs.js'
import { renderPdfWithJs, wrapText } from '../dist/pipeline/render-js.js'

const doc = await PDFDocument.create()
const helv = await doc.embedFont(StandardFonts.Helvetica)

test('wrapText greedily wraps within the width', () => {
  const lines = wrapText('the quick brown fox jumps over the lazy dog', helv, 11, 80)
  assert.ok(lines.length > 1, 'wraps into multiple lines')
  assert.ok(
    lines.every((line) => helv.widthOfTextAtSize(line, 11) <= 80),
    'no line exceeds the width'
  )
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog', 'words preserved')
})

test('wrapText char-breaks an over-wide token without inserting spaces', () => {
  const long = 'x'.repeat(200)
  const lines = wrapText(long, helv, 11, 80)
  assert.ok(lines.length > 1, 'long token is broken across lines')
  assert.ok(lines.every((line) => !line.includes(' ')), 'no artificial spaces inside the token')
  assert.equal(lines.join(''), long, 'characters are preserved exactly')
})

test('wrapText splits on newlines', () => {
  const lines = wrapText('first\nsecond', helv, 11, 500)
  assert.deepEqual(lines, ['first', 'second'])
})

test('renders real English blocks to a valid, round-trippable PDF', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/Norwegian-Singles.pdf', import.meta.url))
  const extracted = await extractPdfWithPdfjs(fixture)
  const blocks = assembleBlocks(extracted.pages.slice(4, 7), extracted.pages)
  assert.ok(blocks.length > 0, 'have blocks to render')

  const out = join(tmpdir(), `pdf-translator-render-${process.pid}.pdf`)
  try {
    const result = await renderPdfWithJs(blocks, out)
    assert.ok(result.pageCount >= 1, 'produced at least one page')

    const bytes = readFileSync(out)
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'is a valid PDF')

    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const { text } = await extractText(pdf, { mergePages: true })
    assert.ok(text.includes('Core Principles'), 'rendered text round-trips out of the PDF')
  } finally {
    rmSync(out, { force: true })
  }
})

test('falls back to Helvetica but refuses non-Latin text without a CJK font', async () => {
  const priorFont = process.env['PDF_TRANSLATOR_FONT']
  process.env['PDF_TRANSLATOR_FONT'] = '' // force fallback (no candidate resolves here)
  const out = join(tmpdir(), `pdf-translator-render-ko-${process.pid}.pdf`)
  try {
    await assert.rejects(
      () => renderPdfWithJs([{ type: 'body', text: '안녕하세요 세계' }], out),
      /CJK font/,
      'guides the user to provide a font'
    )
  } finally {
    rmSync(out, { force: true })
    if (priorFont === undefined) delete process.env['PDF_TRANSLATOR_FONT']
    else process.env['PDF_TRANSLATOR_FONT'] = priorFont
  }
})
