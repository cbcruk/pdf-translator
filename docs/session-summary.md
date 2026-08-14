# 세션 요약: Unlimited-OCR 분석에서 크로스플랫폼 경로까지

Baidu Unlimited-OCR를 참고 삼아 분석한 데서 출발해, gemini 컨텍스트 번역과 파이프라인 네
스테이지의 순수-JS 대체 백엔드까지 이어진 작업의 기록. 개별 결정·실측은 각 노트에 있고, 이
문서는 전체 흐름과 현재 상태를 한눈에 본다.

## 흐름 (PR #1 → #7)

1. **#1 — Unlimited-OCR 분석** ([unlimited-ocr-notes.md](unlimited-ocr-notes.md))
   VLM 기반 OCR라 코드 이식은 거의 없고, 유효한 개념은 하나 — **"번역에 문맥을 넣어라"**(long-horizon).
   실현 지점은 `--engine gemini`.
2. **#2 — gemini 컨텍스트 배치 번역**
   페이지 경계 배치 + 읽기전용 CONTEXT(섹션 헤딩·직전 소스 문단) + 동시성 + in-prompt glossary +
   분할 재시도. 컨텍스트를 *소스*에서 뽑아 배치 독립성 → 동시 실행.
3. **#3 — JSDoc 일괄 추가**
   16개 소스 파일에 함수·상수·타입 주석. 특히 좌하단 원점 좌표계, 문서 전체 통계 근거, 동시성
   불변식을 명시 — 이후 크로스플랫폼 작업의 토대가 됨.
4. **#4 — unpdf 추출기** ([unpdf-notes.md](unpdf-notes.md)) `--extractor pdfjs`
   PDF.js로 텍스트 레이어 추출. item→line 재조립, 좌표계 동일. **크로스플랫폼 스레드의 시작점.**
5. **#5 — pdf-lib 렌더러** ([js-renderer-notes.md](js-renderer-notes.md)) `--renderer js`
   Swift 렌더러 지표 이식, Noto 서브셋 임베딩으로 한글 라운드트립. 텍스트-레이어 크로스플랫폼 경로 완성.
6. **#6 — tesseract.js OCR** ([tesseract-ocr-notes.md](tesseract-ocr-notes.md)) `--ocr tesseract`
   스캔 경로 대체. 래스터화(unpdf+napi-canvas) + OCR + StructuredPage 매핑 + 좌표 변환.
7. **#7 — README 크로스플랫폼 경로 섹션**
   네 플래그 조합 사용법·전제·검증 상태 문서화.

## 크로스플랫폼 경로 현황

기본 파이프라인은 Apple 프레임워크(PDFKit/Vision/TranslationSession/Core Graphics) 기반이라
macOS 26.0+ 전용이다. 각 스테이지에 순수-JS 대체를 얹어, 플래그로 macOS 없이 돌릴 수 있다.

| 스테이지 | macOS 기본 | 크로스플랫폼 플래그 | 상태 |
|---|---|---|---|
| Extract | PDFKit | `--extractor pdfjs` (unpdf) | 실측 ✅ |
| Structure(스캔) | Vision | `--ocr tesseract` (tesseract.js) | 배선✅ / 라이브 OCR 미실행 |
| Translate | Apple NMT | `--engine gemini` | 배선✅ / 라이브 API 미실행 |
| Render | Core Graphics | `--renderer js` (pdf-lib) | 실측 ✅ |

```sh
# 텍스트-레이어 PDF, macOS 없이
export GEMINI_API_KEY=...
node dist/cli.js input.pdf --extractor pdfjs --engine gemini --renderer js --font NotoSansKR-Regular.otf
```

## 설계 원칙 (관통하는 것들)

- **JSON 계약이 seam.** 스테이지 사이가 모두 JSON이라 백엔드를 독립적으로 갈아끼운다. 네 개의
  대체 백엔드가 전부 이 성질 덕에 낮은 비용으로 들어갔다.
- **플래그 독립성.** 크로스플랫폼/Apple 백엔드를 자유 혼합(예: macOS에서 `--extractor pdfjs`만).
- **오프라인 우선.** 폰트·traineddata를 CDN 자동 다운로드에 의존하지 않고 `--font`/`--tessdata`로
  요구(도구의 offline·no-API-key 정체성 유지, 리포 경량화).
- **조용한 실패 금지.** 폰트 없이 한글, traineddata 없이 OCR 등은 tofu·빈 출력 대신 안내 오류.

## 검증 상태와 미검증

- **실측(Linux)**: `--extractor pdfjs`(23p fixture 추출→조립), `--renderer js`(영문 end-to-end +
  한글 임베딩 라운드트립), tesseract 경로의 래스터화·매핑·좌표.
- **미실행(이 샌드박스 한정)**: `--engine gemini`의 라이브 API, `--ocr tesseract`의 라이브 OCR.
  둘 다 배선·단위 테스트는 됐고, 실행만 조직 egress 정책(키·traineddata 다운로드 차단)으로 못 했다.
  실제 키/traineddata 있는 환경에서 패스만 돌리면 된다.

## 알려진 한계 (크로스플랫폼 백엔드)

- `--extractor pdfjs`: bold 정보 없음(fontFamily 제네릭) → 크기 기반 헤딩만.
- `--renderer js`: 단일 폰트 웨이트(헤딩 크기로만 구분), CTFramesetter 대비 줄나눔 근사.
- `--ocr tesseract`: 표/리스트 구조 없음(빈 배열), 정확도·속도 미측정.

## 다음 단계 (원하면)

1. 실제 키/traineddata 환경에서 gemini·tesseract 라이브 패스 검증 + 프롬프트/배치 튜닝.
2. `--renderer js` Bold 페이스 지원, Latin/한글 폰트 캐스케이드.
3. 스캔 표 인식이 필요하면 별도 레이아웃 분석(선 검출 등) 검토.
4. Noto 서브셋을 빌드타임에 준비해 폰트 배포 마찰 줄이기.

## 관련 문서

- [unlimited-ocr-notes.md](unlimited-ocr-notes.md) — Baidu Unlimited-OCR 분석
- [unpdf-notes.md](unpdf-notes.md) — unpdf 추출기 검토·스파이크
- [js-renderer-notes.md](js-renderer-notes.md) — pdf-lib 렌더러 스파이크
- [tesseract-ocr-notes.md](tesseract-ocr-notes.md) — tesseract.js OCR 스파이크
- [README](../README.md) — "Cross-platform path (no macOS)" 섹션
