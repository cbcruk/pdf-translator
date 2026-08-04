/** 리플로우 렌더러가 그릴 수 있는 블록 종류. */
export type BlockType = 'heading' | 'body' | 'table'

/**
 * 블록이 원본 PDF의 어디서 왔는지. 표 블록을 Vision 셀 구조와 매칭할 때
 * 세로 겹침을 계산하는 데 쓰인다. 좌표는 좌하단 원점(y는 위로 갈수록 큼).
 */
export interface BlockSource {
  /** 0-based 페이지 인덱스. */
  page: number
  /** 블록 상단의 y (아래쪽 yBottom보다 크다). */
  yTop: number
  /** 블록 하단의 y. */
  yBottom: number
}

/**
 * 파이프라인의 중심 자료구조. 조립·번역·렌더가 모두 Block 배열을 주고받는다.
 * heading/body는 text만, table은 rows(있으면)로 그린다.
 */
export interface Block {
  type: BlockType
  text: string
  /** 표 셀 텍스트 rows[행][열]. Vision 매칭에 성공한 표에만 존재하며, 없으면 고정폭 텍스트로 강등된다. */
  rows?: string[][]
  /** 원본 위치. 기하 조립 경로에서만 채워지고 스캔 경로에서는 생략될 수 있다. */
  source?: BlockSource
}
