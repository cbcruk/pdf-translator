import type { Block, BlockSource } from './assemble.types.js'
import type { StructureResult, StructuredBox } from './ingest.types.js'

/**
 * 기하 감지로 위치를 잡은 표 블록에 Vision이 인식한 셀 구조(rows)를 입힌다.
 * 같은 페이지에서 세로로 50% 이상 겹치는 표를 매칭 대상으로 본다. 매칭 실패 시
 * 블록은 rows 없이 남아 고정폭 텍스트 렌더로 자연 강등된다. 블록을 제자리에서 변형한다.
 *
 * @returns 셀 구조를 성공적으로 입힌 표 블록 수
 */
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

/** 표 블록이 존재하는 페이지 인덱스들을 정렬해 돌려준다 (Vision을 표 페이지에만 돌리기 위함). */
export function tablePageIndices(blocks: readonly Block[]): number[] {
  const pages = new Set<number>()
  for (const block of blocks) {
    if (block.type === 'table' && block.source !== undefined) {
      pages.add(block.source.page)
    }
  }
  return [...pages].sort((a, b) => a - b)
}

/** 표 블록의 세로 범위(yTop~yBottom) 중 Vision box와 겹치는 비율(0~1). */
function overlapRatio(source: BlockSource, box: StructuredBox): number {
  const top = Math.min(source.yTop, box.y + box.height)
  const bottom = Math.max(source.yBottom, box.y)
  const overlap = Math.max(0, top - bottom)
  const range = source.yTop - source.yBottom
  return range > 0 ? overlap / range : 0
}
