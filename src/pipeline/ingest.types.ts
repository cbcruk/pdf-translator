export interface PdfInfo {
  pageCount: number
  hasTextLayer: boolean
}

export interface ExtractedLine {
  text: string
  fontSize: number
  bold: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface ExtractedPage {
  index: number
  width: number
  height: number
  lines: ExtractedLine[]
}

export interface IngestResult {
  pageCount: number
  pages: ExtractedPage[]
}

export interface StructuredBox {
  x: number
  y: number
  width: number
  height: number
}

export interface StructuredParagraph {
  text: string
  box: StructuredBox
  lineCount: number
}

export interface StructuredTable {
  box: StructuredBox
  rows: string[][]
}

export interface StructuredList {
  box: StructuredBox
  items: string[]
}

export interface StructuredPage {
  index: number
  width: number
  height: number
  title: string | null
  paragraphs: StructuredParagraph[]
  tables: StructuredTable[]
  lists: StructuredList[]
}

export interface StructureResult {
  pageCount: number
  pages: StructuredPage[]
}
