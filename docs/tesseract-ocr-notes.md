# 참고 노트: 스캔 경로 OCR 스파이크 (`--ocr tesseract`, tesseract.js)

크로스플랫폼 경로의 마지막 macOS 종속 조각인 **스캔 문서 구조 인식**(Vision
`RecognizeDocumentsRequest`)을 tesseract.js로 대체하는 스파이크. 이걸로 텍스트-레이어뿐 아니라
스캔 PDF까지 macOS 없이 처리하는 경로의 얼개가 선다.

## 스캔 경로의 조각 둘

텍스트 레이어가 없는 PDF는 `pdf-cli structure`(Vision)가 페이지를 3x 래스터화해 문단/제목/표/
리스트를 인식하고, `blocksFromStructure`가 그걸 블록으로 편다. 이를 대체하려면 **래스터화**와
**OCR** 두 크로스플랫폼 조각이 필요하다.

## 구현

`src/pipeline/structure-tesseract.ts` — `recognizeStructureWithTesseract(path, opts)`가 Vision
경로와 같은 {@link StructureResult} 계약을 만족. `--ocr vision|tesseract`(기본 vision) +
`--tessdata <dir>` / `PDF_TRANSLATOR_TESSDATA`로 게이트.

1. **래스터화**: unpdf `renderPageAsImage`(PDF.js) + `@napi-rs/canvas`로 페이지를 3x PNG로.
2. **OCR**: tesseract.js 워커를 한 번 만들어 페이지별 `recognize(png, {}, { blocks: true })`.
3. **매핑**(`pageFromTesseract`, 순수 함수): tesseract `Page.blocks[].paragraphs[]`를
   `StructuredParagraph`(문단별 bbox·줄 수)로 편다. `tables`/`lists`는 빈 배열.
4. **좌표 변환**(`bboxToBox`, 순수 함수): tesseract bbox는 **이미지 픽셀·좌상단 원점(y 아래로)**,
   `StructuredBox`는 **포인트·좌하단 원점**. `y = heightPts - y1/scale`, `height=(y1-y0)/scale`
   등으로 변환해 `blocksFromStructure`의 `y+height`(상단) 읽기순서 규약과 맞춘다.

## 실측 결과 (macOS 없이 Linux에서)

- ✅ **래스터화 동작**: `Norwegian-Singles.pdf` 페이지 → `@napi-rs/canvas`로 PNG(26KB, PNG
  시그니처 확인). OCR 입력 절반이 성립.
- ✅ **매핑·좌표 변환 검증**: `pageFromTesseract`/`bboxToBox` 단위 테스트 + mock 페이지를
  `blocksFromStructure`에 넣어 헤딩 승격·읽기순서까지 통합 확인.
- ✅ tessdata 없을 때 명확한 안내로 실패(조용한 실패 방지).
- 테스트: `test/structure-tesseract.test.mjs`, 전부 헤르메틱.

## 라이브 OCR은 이 샌드박스에서 미실행 (중요)

tesseract.js는 `<lang>.traineddata`가 필요한데:

- **다운로드 차단**: 기본 CDN(jsDelivr)과 GitHub(naptha/tessdata) 모두 이 세션의 조직 egress
  정책에서 403. 정책상 우회 금지.
- **시스템 설치본 없음**: 컨테이너에 tesseract 바이너리·traineddata 부재.

따라서 **실제 이미지 → 텍스트 인식 정확도/속도는 이 환경에서 검증하지 못했다.** 이는
`--engine gemini`가 라이브 API로 검증되지 않은 것과 같은 성격의 미검증이다. 래스터화·매핑·좌표·
계약 배선은 모두 확인됐고, traineddata가 있는 머신에서 `--tessdata`로 OCR 패스만 돌리면 된다.
(오프라인 정체성에 맞춰 CDN 자동 다운로드에 의존하지 않고 로컬 traineddata를 요구하도록 설계함.)

## 한계

- **표/리스트 구조 없음**: tesseract는 문단은 주지만 표·리스트를 분리하지 않아 `tables`/`lists`가
  빈 배열. Vision 대비 표 인식이 사라지는 강등(문단으로만 흐른다).
- **제목 감지 없음**: `title: null` — 헤딩은 `blocksFromStructure`의 줄 높이 기반 승격에만 의존.
- **정확도·성능 미측정**: 실 OCR 미실행. 큰 문서는 페이지당 수 초가 걸릴 수 있어 `--pages`로
  범위를 좁히도록 인식 대상 페이지만 넘긴다.
- **네이티브 의존**: `@napi-rs/canvas`(prebuilt 바이너리, 플랫폼별). 순수 JS는 아니지만 크로스
  플랫폼.

## 판단

- 스캔 경로의 두 조각(래스터화·매핑) 중 검증 가능한 부분은 모두 성립. OCR 엔진은 배선·단위
  테스트까지 됐고, 남은 건 traineddata 있는 환경에서의 라이브 정확도 검증뿐.
- **기본 전환은 아님**: 표 인식 상실 + 정확도 미검증 + Vision 대비 품질 불확실. 기본은 vision
  유지, tesseract는 non-macOS 스캔용 옵트인.
- **다음 단계(원하면)**: ① traineddata 있는 머신에서 실 스캔 PDF로 정확도/속도 측정,
  ② traineddata 배포 방식(빌드타임 준비 vs `--tessdata` 요구), ③ 표 인식이 필요하면 별도
  레이아웃 분석(예: OpenCV 선 검출) 검토.

## 크로스플랫폼 경로 총정리

이 스파이크로 세 macOS 종속 스테이지의 대체가 모두 얼개를 갖췄다:

| 스테이지 | macOS 기본 | 크로스플랫폼 대체 | 상태 |
|---|---|---|---|
| Extract | PDFKit | `--extractor pdfjs` (unpdf) | 실측 ✅ |
| Structure(스캔) | Vision | `--ocr tesseract` (tesseract.js) | 배선✅ / 라이브 OCR 미실행 |
| Translate | Apple NMT | `--engine gemini` | 배선✅ / 라이브 API 미실행 |
| Render | Core Graphics | `--renderer js` (pdf-lib) | 실측 ✅ |
