import type { Block, BlockSource } from './assemble.types.js'
import type { StructureResult, StructuredBox } from './ingest.types.js'

// 기하 감지로 위치를 잡은 표 블록에 Vision이 인식한 셀 구조를 입힌다.
// 매칭 실패 시 rows 없이 남아 고정폭 텍스트 렌더로 자연 강등된다.
export function attachTableStructure(blocks: Block[], structure: StructureResult): number {
  let matched = 0
  for (const block of blocks) {
    if (block.type !== 'table' || block.source === undefined) {
      continue
    }
    const page = structure.pages.find((candidate) => candidate.index === block.source?.page)
    if (page === undefined) {
      continue
    }
    const table = page.tables.find(
      (candidate) => overlapRatio(block.source as BlockSource, candidate.box) >= 0.5
    )
    if (table !== undefined && table.rows.length > 0) {
      block.rows = table.rows
      matched++
    }
  }
  return matched
}

export function tablePageIndices(blocks: readonly Block[]): number[] {
  const pages = new Set<number>()
  for (const block of blocks) {
    if (block.type === 'table' && block.source !== undefined) {
      pages.add(block.source.page)
    }
  }
  return [...pages].sort((a, b) => a - b)
}

function overlapRatio(source: BlockSource, box: StructuredBox): number {
  const top = Math.min(source.yTop, box.y + box.height)
  const bottom = Math.max(source.yBottom, box.y)
  const overlap = Math.max(0, top - bottom)
  const range = source.yTop - source.yBottom
  return range > 0 ? overlap / range : 0
}
