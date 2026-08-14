import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { extractPdfWithPdfjs, groupItemsIntoLines } from '../dist/pipeline/extract-pdfjs.js'

const item = (over) => ({
  str: '',
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  fontSize: 10,
  fontFamily: 'sans-serif',
  dir: 'ltr',
  hasEOL: false,
  ...over,
})

test('groups items into lines and drops stray empty EOL markers', () => {
  // 실제 fixture에서 관찰된 패턴: 큰 제목, 다음 줄 y에 놓인 빈 EOL 마커, 본문.
  const lines = groupItemsIntoLines([
    item({ str: 'Norwegian Singles', x: 219, y: 591, width: 172, height: 20.6, fontSize: 20.6 }),
    item({ str: '', x: 236, y: 566, fontSize: 11.9, hasEOL: true }),
    item({ str: 'An Approach To Running', x: 236, y: 566, width: 139, height: 11.9, fontSize: 11.9 }),
  ])
  assert.equal(lines.length, 2)
  assert.equal(lines[0].text, 'Norwegian Singles')
  assert.ok(lines[0].fontSize > 20, 'heading keeps its large font size')
  assert.equal(lines[1].text, 'An Approach To Running')
  assert.ok(lines[1].fontSize < 12, 'body keeps its small font size')
  assert.ok(lines.every((line) => line.bold === false), 'bold is always false (unpdf has no weight)')
})

test('merges a multi-item line and breaks on hasEOL', () => {
  const lines = groupItemsIntoLines([
    item({ str: 'Hello ', x: 10, y: 100, width: 30 }),
    item({ str: 'world', x: 40, y: 100, width: 25, hasEOL: true }),
    item({ str: 'next', x: 10, y: 88, width: 20 }),
  ])
  assert.equal(lines.length, 2)
  assert.equal(lines[0].text, 'Hello world')
  assert.equal(lines[0].x, 10)
  assert.equal(lines[0].width, 55) // maxX(65) - minX(10)
  assert.equal(lines[1].text, 'next')
})

test('breaks a line on a large baseline jump even without hasEOL', () => {
  const lines = groupItemsIntoLines([
    item({ str: 'top', x: 10, y: 200, width: 20 }),
    item({ str: 'bottom', x: 10, y: 150, width: 20 }),
  ])
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((l) => l.text), ['top', 'bottom'])
})

test('extracts the real fixture end-to-end via unpdf', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/Norwegian-Singles.pdf', import.meta.url))
  const result = await extractPdfWithPdfjs(fixture)

  assert.equal(result.pageCount, 23)
  assert.equal(result.pages.length, 23)

  const firstPage = result.pages[0]
  assert.ok(firstPage.width > 0 && firstPage.height > 0, 'page dimensions are populated')
  assert.ok(firstPage.lines.length > 0, 'first page has lines')
  assert.ok(firstPage.lines.every((line) => line.text.length > 0), 'no empty line text')

  const title = firstPage.lines.find((line) => line.text.includes('Norwegian Singles'))
  assert.ok(title, 'title line is present')

  // 본문 대비 제목 폰트가 더 크다 (bold 없이도 크기 기반 헤딩 감지가 살아 있음을 확인).
  const bodySizes = firstPage.lines.filter((l) => l.text.length > 30).map((l) => l.fontSize)
  if (bodySizes.length > 0) {
    const medianBody = bodySizes.sort((a, b) => a - b)[Math.floor(bodySizes.length / 2)]
    assert.ok(title.fontSize > medianBody, 'title font is larger than body')
  }

  // 페이지 내 줄은 대체로 위→아래(y 내림차순) 읽기 순서를 유지한다.
  const ys = firstPage.lines.map((l) => l.y)
  const descending = ys.filter((y, i) => i === 0 || y <= ys[i - 1]).length
  assert.ok(descending / ys.length > 0.8, 'lines are mostly in top-to-bottom order')
})
