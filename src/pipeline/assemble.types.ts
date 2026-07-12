export type BlockType = 'heading' | 'body' | 'table'

export interface BlockSource {
  page: number
  yTop: number
  yBottom: number
}

export interface Block {
  type: BlockType
  text: string
  rows?: string[][]
  source?: BlockSource
}
