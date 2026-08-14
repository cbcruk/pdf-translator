import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'
import { blocksFromStructure } from '../dist/pipeline/structure-blocks.js'
import { bboxToBox, pageFromTesseract, recognizeStructureWithTesseract } from '../dist/pipeline/structure-tesseract.js'

test('bboxToBox converts top-left pixels to bottom-left points', () => {
  // 792pt 페이지를 3x로 래스터화 → 이미지 높이 2376px. 상단 근처 문단.
  const top = bboxToBox({ x0: 96, y0: 30, x1: 300, y1: 90 }, 792, 3)
  assert.equal(top.x, 32) // 96/3
  assert.equal(top.width, 68) // (300-96)/3
  assert.equal(top.height, 20) // (90-30)/3
  assert.equal(top.y, 762) // 792 - 90/3  (하단 모서리)
  // 상단 모서리 = y + height = 782, 페이지 top(792)에 가깝다
  assert.equal(top.y + top.height, 782)

  const bottom = bboxToBox({ x0: 96, y0: 2286, x1: 300, y1: 2346 }, 792, 3)
  assert.equal(bottom.y + bottom.height, 30) // 페이지 bottom에 가깝다
})

const bbox = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 })
const para = (text, box, lineCount) => ({
  text,
  bbox: box,
  is_ltr: true,
  confidence: 90,
  lines: Array.from({ length: lineCount }, () => ({})),
})

test('pageFromTesseract maps blocks/paragraphs and drops empty ones', () => {
  const page = {
    blocks: [
      {
        // 헤딩: 한 줄, 줄 높이 30pt(=90px/3). 본문(줄 높이 10pt)의 1.3배를 크게 넘는다.
        paragraphs: [
          para('Big Heading', bbox(96, 30, 400, 120), 1),
          para('   ', bbox(0, 0, 0, 0), 1), // 공백뿐 → 버려짐
          para('Body text that spans two lines here.', bbox(96, 150, 500, 210), 2),
          para('A second body paragraph over three lines here.', bbox(96, 240, 500, 330), 3),
        ],
        text: '',
        confidence: 90,
        bbox: bbox(96, 30, 500, 330),
        blocktype: 'text',
      },
    ],
  }
  const structured = pageFromTesseract(page, 0, 612, 792, 3)
  assert.equal(structured.paragraphs.length, 3, 'empty paragraph dropped')
  assert.deepEqual(structured.tables, [])
  assert.deepEqual(structured.lists, [])
  assert.equal(structured.width, 612)

  // blocksFromStructure로 실제 조립 — 큰 한 줄 문단이 heading으로 승격되는지
  const blocks = blocksFromStructure([structured])
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].type, 'heading')
  assert.equal(blocks[0].text, 'Big Heading')
  assert.equal(blocks[1].type, 'body')
  assert.equal(blocks[2].type, 'body')
})

test('rasterizes a real PDF page to a PNG (the OCR input half)', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/Norwegian-Singles.pdf', import.meta.url))
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(fixture)))
  const png = await renderPageAsImage(pdf, 1, {
    canvasImport: () => import('@napi-rs/canvas'),
    scale: 2,
  })
  const bytes = new Uint8Array(png)
  assert.ok(bytes.byteLength > 1000, 'produced a non-trivial image')
  // PNG 시그니처 \x89PNG
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('refuses to run without local traineddata, guiding the user', async () => {
  const prior = process.env['PDF_TRANSLATOR_TESSDATA']
  process.env['PDF_TRANSLATOR_TESSDATA'] = ''
  try {
    await assert.rejects(
      () => recognizeStructureWithTesseract('does-not-matter.pdf', { tessdataPath: '/no/such/tessdata' }),
      /traineddata/,
      'points the user to --tessdata'
    )
  } finally {
    if (prior === undefined) delete process.env['PDF_TRANSLATOR_TESSDATA']
    else process.env['PDF_TRANSLATOR_TESSDATA'] = prior
  }
})
