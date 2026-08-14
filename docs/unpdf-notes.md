# 참고 노트: unpdf (unjs) + `--extractor pdfjs` 스파이크

출처: https://github.com/unjs/unpdf

Mozilla PDF.js를 모든 JS 런타임(Node/Deno/Bun/브라우저/서버리스)에서 돌아가게 감싼 순수 JS
라이브러리. `pdf-parse`의 현대적 대안. pdf-translator에 검토한 기록과, 결론에 따라 진행한
`--extractor pdfjs` 스파이크의 구현·실측 정리.

## unpdf가 pdf-translator의 어디에 닿나 — extract 한 스테이지뿐

파이프라인 5스테이지 중 unpdf가 대체 가능한 건 **텍스트 레이어 추출**뿐이다. OCR·표 구조·
읽기순서 추론은 unpdf에 없다.

| 스테이지 | 현재 | unpdf 대체 |
|---|---|---|
| Detect (`info`) | PDFKit | △ (텍스트레이어 유무 판정은 직접) |
| **Extract (`extract`)** | **PDFKit → per-line bbox+font** | **✅ 이 스파이크** |
| Structure (`structure`) | Vision | ❌ OCR·표 없음 |
| Translate | Apple NMT / Gemini | ❌ 무관 |
| Render (`render`) | Core Graphics | ❌ 없음 |

## unpdf API 실측 (v1.8.1)

- `extractTextItems(dataOrProxy)` → `{ totalPages, items: StructuredTextItem[][] }` (페이지별 배열).
  각 항목: `{ str, x, y, width, height, fontSize, fontFamily, dir, hasEOL }`.
  - x/y는 **좌하단 원점**(PDF 관례) — 기존 `ExtractedLine` 좌표계와 동일, 뒤집기 불필요.
  - `withDocument`가 `isPDFDocumentProxy`로 프록시를 재사용 → `getDocumentProxy` 한 번 파싱 후
    넘기면 **재파싱 없음**.
- 페이지 크기는 항목에 없음 → `pdf.getPage(n).getViewport({scale:1})`로 별도 취득 (`removeFurniture`가
  `page.height`를 씀).
- **item ≠ line**: PDF.js는 문자 런(item) 단위. PDFKit이 공짜로 주던 줄 그룹핑을 직접 해야 함
  (`hasEOL` 1차 신호 + baseline 급변 2차 가드).

## 스파이크 구현

`src/pipeline/extract-pdfjs.ts` — `extractPdfWithPdfjs(path): Promise<IngestResult>`가 기존 계약을
그대로 만족. `--extractor apple|pdfjs` 플래그로 게이트(기본 apple), 텍스트레이어 경로의
`extractPdf`만 교체하고 나머지(info/structure/render)는 Swift 그대로. `groupItemsIntoLines`는
순수 함수로 분리해 단위 테스트 가능.

## 실측 결과 (fixtures/Norwegian-Singles.pdf, 23p, macOS 없이 Linux에서)

- ✅ 23페이지 추출 → `assembleBlocks`로 문단 조립까지 깔끔 (본문/글머리표/URL 보존)
- ✅ `bold=false`인데도 "Norwegian Singles"·"1 Core Principles" 등 헤딩을 **폰트 크기로 감지**
- ✅ 페이지 내 읽기순서(y 내림차순) 유지
- ✅ Swift 툴체인 없이 extract→assemble→blocks 전 과정 동작
- 테스트: `test/extract-pdfjs.test.mjs` (그룹핑 단위 + 실 fixture 통합)

## 한계 (스파이크에서 확인)

- **bold 복원 불가.** unpdf의 `fontFamily`가 `"sans-serif"`류 **제네릭으로 뭉개져** 굵기 정보가
  없다. 그래서 `bold`는 항상 false. `isHeading`의 큰-폰트 경로는 살지만 **본문 크기의 볼드-only
  헤딩은 놓친다.** 실 복원은 raw PDF.js(`getResolvedPDFJS` + `commonObjs`, `getOperatorList`로 폰트
  강제 로드)까지 내려가야 해 unpdf의 간결함을 버리게 된다 — 스파이크에선 채택하지 않음.
- **height는 근사** (PDF.js text item height ≈ 폰트 크기). 문단 나눔 통계에 미세 영향.
- **macOS 종속은 그대로.** structure(Vision)·render(Core Graphics)가 Swift로 남으므로, extract만
  바꿔도 전체는 여전히 macOS 전용.

## 판단

- **드롭인 이득으로 지금 기본 전환? → 아니오.** Swift가 structure+render로 남는 한 측면 이동이고,
  item→line 그룹핑·bold 상실이라는 새 표면적이 생긴다. 그래서 **기본은 apple 유지, 플래그로만 제공.**
- **가치가 있는 경우:**
  - **크로스플랫폼/서버리스** 로드맵의 첫 벽돌. `--engine gemini`(구현됨) + `--extractor pdfjs` +
    JS 렌더러(pdf-lib 등)를 갖추면 macOS 없이 텍스트-레이어 PDF를 번역하는 경로가 열린다. 이번
    스파이크가 그 경로의 절반(추출+번역)이 실제로 성립함을 보였다.
  - PDFKit 추출이 특정 PDF에서 오작동할 때의 **폴백/교차검증 추출기**.
- **다음 단계(원하면):** ① bold를 raw PDF.js로 복원할지 비용 대비 판단, ② JS 렌더러 스파이크로
  크로스플랫폼 경로 완성 여부 확인.
