# 참고 노트: JS 렌더러 스파이크 (`--renderer js`, pdf-lib)

unpdf 노트(`docs/unpdf-notes.md`)에서 "크로스플랫폼 경로의 마지막 조각"으로 지목한 JS 렌더러를
스파이크한 기록. Swift/Core Graphics `pdf-cli render`의 대체 백엔드를 pdf-lib로 구현하고,
`--extractor pdfjs` + `--engine gemini`와 합쳐 **macOS 없이 EN→KO PDF 번역이 성립함을 실증**했다.

## 왜 이걸 했나

파이프라인의 macOS 종속 스테이지는 셋 — structure(Vision), translate(Apple NMT), render(Core
Graphics). 이 중 render가 마지막 벽이었다. extract(unpdf)·translate(gemini)는 이미 크로스플랫폼
경로가 있으므로, JS 렌더러가 되면 **텍스트-레이어 PDF에 한해** 완전 크로스플랫폼 경로가 열린다.
(스캔 PDF는 여전히 Vision OCR이 필요해 macOS 전용.)

## 구현

`src/pipeline/render-js.ts` — `renderPdfWithJs(blocks, outputPath, {fontPath})`가 Swift 렌더러와
같은 `RenderResult` 계약을 만족. `--renderer swift|js`(기본 swift)와 `--font <path>`로 게이트.
Swift 렌더러의 지표를 그대로 옮김: Letter 612×792, 64pt 여백, body 11pt/heading 16pt/table 9pt,
격자 표(0.55 그레이 0.5pt 테두리, 열 폭 자동 축소, 셀 내 줄바꿈), bottom-left 커서 페이지네이션.

- **줄바꿈**(`wrapText`): 공백 greedy + 폭 초과 낱말은 글자 단위 분해(긴 URL·공백 없는 CJK 방어),
  낱말 중간엔 인위적 공백 없음.
- **폰트 해석**: `--font` → `PDF_TRANSLATOR_FONT` → 후보 경로(Noto 흔한 위치) 순. 못 찾으면
  Helvetica로 폴백.

## 폰트: 핵심 발견 (실측, pdf-lib 1.17 + @pdf-lib/fontkit 1.1)

- **한글 출력엔 fontkit로 임베딩 가능한 단일 CJK 폰트(.otf/.ttf)가 필요.** Noto Sans CJK KR을
  `subset:true`로 임베딩하면 완벽 동작 — 한글 라운드트립 정확, **서브셋 덕에 출력 30KB**(전체
  임베딩은 13MB).
- **임베딩 안 되는 것들**: `unifont.otf`("Not a CFF Font"), `.ttc` 컬렉션(WenQuanYi 등 —
  "createSubset is not a function"). fontkit은 단일 폰트 파일만.
- **폴백 Helvetica는 WinAnsi(CP1252) 전용**: 스마트 따옴표·불릿·대시(`" • —`)는 되지만 한글은
  불가. 그릴 수 없는 문자가 있으면 `--font` 지정을 안내하는 오류를 던진다(조용한 tofu 방지).

## 실측 결과 (macOS 없이 Linux에서)

- ✅ **완전 경로 실증**: `Norwegian-Singles.pdf` → `--extractor pdfjs` 추출 → assemble →
  `renderPdfWithJs` 렌더 → 생성 PDF에서 텍스트 재추출까지 (영문, Helvetica 폴백)
- ✅ **한글 end-to-end**: Noto 임베딩으로 헤딩·본문·표 격자·URL 포함 블록 렌더 → 라운드트립 정확
  (`"1 서브 임계 접근법 … 주간 거리 80km 강도 서브 임계"`)
- ✅ Swift 툴체인 없이 동작. 테스트: `test/render-js.test.mjs`(줄바꿈 단위 + 실 fixture 통합 +
  폴백 가드), 전부 헤르메틱(네트워크 없이)

## 한계 (스파이크에서 확인)

- **헤딩 볼드 없음**: 임베딩 CJK는 단일 웨이트라 헤딩을 크기(16pt)로만 구분. Swift는 SD Gothic
  Bold를 씀. 볼드가 필요하면 Bold 페이스를 별도 `--font`로 받는 확장이 필요.
- **폰트 배포 문제**: 프로덕션 한글 출력은 사용자가 Noto Sans KR 등을 설치하거나 `--font`로
  지정해야 함(리포에 16MB 폰트를 넣지 않음). Apple 경로가 언어팩 사전설치를 요구하는 것과 같은 성격.
- **레이아웃은 근사**: Core Graphics의 `CTFramesetter` 대비 자체 greedy 줄바꿈이라 줄나눔·자간이
  미세하게 다름. Latin/한글 분리 폰트 캐스케이드(Swift의 품질 트릭)도 없음.
- **스캔 경로는 여전히 macOS**: structure(Vision)가 남으므로, 완전 크로스플랫폼은 텍스트-레이어
  PDF에 한함.

## 판단

- **크로스플랫폼 경로가 실제로 성립함을 확인.** `--extractor pdfjs --engine gemini --renderer js`
  세 플래그로 텍스트-레이어 PDF를 macOS 없이 EN→KO 번역할 수 있다. 이번 스파이크로 세 조각이
  모두 실증됐다.
- **기본 전환은 아님**: 품질(폰트 캐스케이드·볼드·CTFramesetter)에서 Swift가 앞서고, 스캔 경로가
  남으므로 기본은 swift 유지. JS 경로는 non-macOS/서버리스용 옵트인.
- **다음 단계(원하면)**: ① Bold 페이스 지원, ② 스캔 경로용 크로스플랫폼 OCR(tesseract.js 등) 검토,
  ③ Noto 서브셋을 빌드 타임에 준비해 배포 마찰 줄이기.
