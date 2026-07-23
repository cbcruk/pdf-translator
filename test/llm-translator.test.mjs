import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmTranslator } from '../dist/translator/llm-translator.js'
import { maskProtectedSpans } from '../dist/pipeline/protect.js'

// TRANSLATE 배열을 그대로 되돌리는 mock transport. requests 배열에 프롬프트를 기록한다.
function installMockFetch() {
  const requests = []
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).contents[0].parts[0].text
    requests.push(prompt)
    const marker = 'TRANSLATE:\n'
    const items = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length))
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            { content: { parts: [{ text: JSON.stringify(items.map((s) => `KO(${s})`)) }] } },
          ],
        }
      },
    }
  }
  return requests
}

const glossary = { 'sub-threshold': '서브 임계' }

test('gemini path leaves glossary terms unmasked but still masks URLs', () => {
  const { masked } = maskProtectedSpans(['a sub-threshold value at https://x.com'], glossary, {
    maskGlossary: false,
  })
  assert.ok(masked[0].includes('sub-threshold'), 'glossary term stays intact')
  assert.ok(!masked[0].includes('x.com'), 'URL is still masked')
})

test('apple path masks glossary terms', () => {
  const { masked } = maskProtectedSpans(['a sub-threshold value'], glossary, { maskGlossary: true })
  assert.ok(!masked[0].includes('sub-threshold'), 'glossary term is masked')
})

test('batches by page boundary and size cap, preserving order under concurrency', async () => {
  const requests = installMockFetch()
  const units = [{ text: 'Introduction', kind: 'heading', section: '', page: 0 }]
  for (let i = 0; i < 21; i++) {
    units.push({ text: `body-${i}`, kind: 'body', section: 'Introduction', page: 0 })
  }
  for (let i = 0; i < 3; i++) {
    units.push({ text: `p1-body-${i}`, kind: 'body', section: 'Methods', page: 1 })
  }

  const translator = new LlmTranslator({ apiKey: 'x', model: 'm' })
  let lastProgress = 0
  const out = await translator.translate(units, {
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    glossary,
    onProgress: (completed, total) => {
      lastProgress = completed
      assert.equal(total, units.length)
    },
  })

  assert.equal(out.length, units.length)
  assert.deepEqual(out, units.map((u) => `KO(${u.text})`), 'order preserved despite concurrency')
  assert.equal(lastProgress, units.length, 'progress reaches total')
  // page 0: 22 units → [20, 2]; page 1: 3 units → [3]
  assert.equal(requests.length, 3, 'split into 20/2/3 batches')
  assert.ok(
    requests.every((p) => p.includes('sub-threshold → 서브 임계')),
    'glossary directive is in every prompt'
  )
  const pageOneBatch = requests.find((p) => p.includes('p1-body-0'))
  assert.ok(pageOneBatch.includes('Section heading: Methods'), 'batch carries its section heading')
  assert.ok(pageOneBatch.includes('Preceding text:'), 'batch carries preceding source context')
})

test('splits and retries on a count mismatch, falling back to source for a stuck unit', async () => {
  const attempts = []
  // 항상 0개짜리 배열을 반환 → 개수 불일치. 단위 1개까지 쪼개도 실패하면 원문 유지여야 한다.
  globalThis.fetch = async (_url, init) => {
    attempts.push(JSON.parse(init.body).contents[0].parts[0].text)
    return {
      ok: true,
      async json() {
        return { candidates: [{ content: { parts: [{ text: '[]' }] } }] }
      },
    }
  }
  const units = [
    { text: 'alpha', kind: 'body', page: 0 },
    { text: 'beta', kind: 'body', page: 0 },
  ]
  const translator = new LlmTranslator({ apiKey: 'x', model: 'm' })
  const out = await translator.translate(units, { sourceLanguage: 'en', targetLanguage: 'ko' })
  assert.deepEqual(out, ['alpha', 'beta'], 'stuck units fall back to source text')
  assert.ok(attempts.length >= 3, 'batch of 2 was split into single-unit retries')
})
