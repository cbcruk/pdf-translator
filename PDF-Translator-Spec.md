# PDF 번역기 — Claude Code 실행 스펙

> macOS 온디바이스 PDF → 번역 PDF 도구. 이 문서는 Claude Code에서 구현을 시작하기 위한 핸드오프 브리프다.
> 그대로 프로젝트 루트에 두거나(`CLAUDE.md`로 rename 가능), 초기 컨텍스트로 붙여넣어 사용한다.

---

## 1. 목표

- 입력 PDF를 읽어 **번역된 PDF**를 생성한다. 주 방향은 **EN → KO**.
- **리플로우 방식** — 원본 레이아웃 재현(overlay)이 아니라, 읽기 순서만 복원해 깨끗한 새 문서로 흘린다. "크롬 읽기모드처럼 텍스트만 잘 정렬되면 충분"이 기준.
- **온디바이스·무료·오프라인**. API 키·레이트리밋·모델 다운로드 호스트·CJK 폰트 임베딩 문제를 모두 회피.

## 2. 왜 이 설계인가 (배경 맥락)

- 브라우저 내장 번역기는 **DOM에만** 작동한다. PDF 뷰어(PDFium)는 페이지를 래스터로 "칠하기" 때문에 번역기가 붙을 트리가 없다 → 그래서 우리가 직접 추출·번역·재구성한다.
- **overlay vs reflow**: overlay는 bbox 오버플로우·폰트 축소·CJK 좌표계산 지옥. 고정 레이아웃은 리플로우가 안 되므로, 충실도를 포기하고 가독성을 택했다.
- **"개인 맥" 제약**을 걸면 Apple 온디바이스 프레임워크(Vision/Translation)를 쓸 수 있어, 위 문제들이 한꺼번에 사라진다. 이게 이 프로젝트의 핵심 전제.

## 3. 전제 조건 / 환경

- **macOS 전용**. Node 18+, Swift toolchain(Xcode Command Line Tools).
- 버전: Vision OCR은 macOS 13(Ventura)+, Translation 프레임워크는 macOS 15(Sequoia)+. 가능하면 최신(macOS 26)에서 검증.
- 기본은 클라우드 없음. 단, **번역 엔진은 교체 가능한 seam**으로 유지(고난도 문서만 LLM 라우팅).

## 4. 아키텍처 (확정)

- **오케스트레이션은 Node/TS**에 둔다. Swift는 프레임워크 경계에서만 내려간다. (전체 스택을 Xcode로 옮기지 **않는다**.)
- Swift 자원을 **비대칭**으로 쓴다:
  - **OCR** → node-swift **인프로세스 바인딩** (기존 `vision-ocr` 모듈). 스캔본 전용.
  - **번역** → **별도 Swift CLI 프로세스**. Node가 shell-out 한다. (이유는 §6.)

```
PDF
 ├─ 텍스트 레이어 있음 ─▶ PDFKit 텍스트 추출 (문단 구조 유지, Vision 생략)
 └─ 스캔본 ───────────▶ 페이지 래스터화 ─▶ vision-ocr (node-swift, 인프로세스)
        │
        ▼
   문단 조립 (줄이 아니라 문단 단위로 묶기 — 번역 문맥 확보)
        │
        ▼
   translate-CLI (별도 프로세스: SwiftUI 호스팅 → TranslationSession 배치)
        │
        ▼
   PDFKit / Core Text 리플로우 (OS 내장 한국어 폰트) ─▶ 번역 PDF
```

## 5. 단계별 명세

1. **Ingest (PDFKit)**: 텍스트 레이어 유무 판별. 있으면 PDFKit로 텍스트+문단 추출하고 Vision을 건너뛴다. 스캔본이면 페이지를 이미지로 래스터화.
2. **OCR (스캔본만)**: `vision-ocr` 호출. 현재 `VNRecognizeTextRequest`(`.accurate`, `usesLanguageCorrection`, `["ko-KR","en-US"]`). → **업그레이드 후보**: `RecognizeDocumentsRequest`(문단/표/리스트 그룹핑). 번역 문맥·표 보존이 필요하면 이쪽.
3. **문단 조립**: OCR/추출 결과를 **문단 단위**로 정규화. 번역 품질은 여기서 갈린다(줄 단위로 넘기면 문맥이 깨짐).
4. **번역 (translate-CLI)**: `TranslationSession`의 배치 API `translations(from:)`(순서 보존, 한 번에 반환)로 문단 배열을 EN→KO. seam 인터페이스 뒤에 두어 Apple/LLM 교체 가능하게.
5. **리플로우 출력**: PDFKit/Core Text로 새 PDF 작성. 제목/본문은 폰트 크기로 구분, 자동 페이지네이션. 한국어 폰트는 OS 내장이라 임베딩 불필요.

## 6. 제일 먼저 뚫을 미지수 ⚠️ (프로젝트 성패)

**`TranslationSession`은 SwiftUI에 결합돼 있다.** session은 View에 붙인 `.translationTask(...)`에서만 나온다(문자열→문자열 프로그래매틱 경로조차 그렇다). Apple 엔지니어가 "UIKit 앱도 Translation을 쓰려면 SwiftUI View를 호스팅해야 한다"고 확인했다.

→ 따라서 CLI는 **숨은 SwiftUI View + run loop**을 띄워 그 안에서 session을 받아야 한다. `VNRecognizeTextRequest`처럼 "perform하면 끝"이 아니다. 이걸 node-swift 동기 콜에 박으면 Node 이벤트 루프 위에 NSApplication run loop을 얹는 꼴이라 지저분 → **별도 프로세스**가 정답.

- **선례**: franzai `translate` CLI가 정확히 이 패턴(SwiftUI 호스팅 + 배치 + 100% 온디바이스 + 키 없음). 참고 삼을 것.
- **마일스톤 1 (스파이크)**: 독립 Swift CLI가 (a) 숨은 View 호스팅, (b) session 획득, (c) stdin 배치 → `translations(from:)` → stdout NDJSON, (d) 깨끗한 종료 — 이게 도는지부터 증명한다. 나머지는 여기 성공 후.
- **버전 확인**: 현재 macOS에서 non-SwiftUI 진입점이 새로 생겼는지 실기에서 찔러본다(SwiftUI 결합은 2024 자료 기준). 있으면 위 호스팅이 단순화된다.

## 7. 리스크 순 마일스톤

1. **translate-CLI SwiftUI 호스팅 스파이크** (§6). 최대 미지수.
2. **언어팩 처리**: ko 미설치 시 첫 실행에 시스템 다운로드 시트가 뜬다(설치돼 있으면 조용히 진행). 헤드리스 운용이면 ko 팩 사전 설치. 가용성은 `LanguageAvailability`로 프로그래밍 검사.
3. **Node/TS 오케스트레이터 골격**: PDFKit 분기 + vision-ocr 호출 + translate-CLI shell-out + 리플로우 연결.
4. **리플로우 품질**: CJK 줄바꿈, 문단 간격, 제목 감지, 페이지 경계.
5. *(선택)* `RecognizeDocumentsRequest` 업그레이드로 표/구조 보존.

## 8. 품질 노트

- **Apple 번역 ≈ 시스템 Translate NMT**. Argos보다 확실히 위, 클라우드 LLM(Gemini-3-pro 등)보다 아래. 세그먼트 단위라 **긴 문서의 용어·톤 일관성 천장**이 있다.
- 그래서 **seam 유지**: 기본은 Apple 온디바이스, 고난도·고가치 문서만 동일 인터페이스로 LLM에 라우팅.
- 번역엔 **줄이 아니라 문단**을 넘긴다(문맥).
- OCR 텍스트를 downstream LLM에 넘길 땐 "OCR 결과라 인식 오류 가능"이라고 알려주면 품질이 오른다.

## 9. 설계 시 유의할 알려진 한계

- **vision-ocr**: 이미지 전용(PDF는 앞단에서 래스터화), 평평한 트랜스크립트(bbox/문단 없음), 동기·블로킹, ko/en 고정·컴파일 인, macOS 전용.
- 리플로우는 **원본 레이아웃을 의도적으로 포기**.
- **다단/표**: raw `VNRecognizeTextRequest`는 줄 병합까지만 → 구조가 필요하면 `RecognizeDocumentsRequest`.

## 10. 검증된 핵심 API 사실

**Translation**
- `TranslationSession` — 온디바이스 ML 모델, Translate 앱과 시스템 공유.
- 배치: `translations(from: [Request]) async -> [Response]`(순서 보존, 일괄 반환) / `translate(batch:) -> BatchResponse`(AsyncSequence).
- session은 SwiftUI `.translationTask`에서만. 첫 사용 시 미설치 언어는 다운로드 시트.

**Vision**
- `VNRecognizeTextRequest`: `.fast`/`.accurate`, `usesLanguageCorrection`, `recognitionLanguages`(BCP-47, 우선순위), `boundingBox`는 **bottom-left 정규화 좌표** → 위→아래 정렬하려면 `1 - midY`로 뒤집기. 지원 언어는 `supportedRecognitionLanguages(for:revision:)`로 질의.
- `RecognizeDocumentsRequest`(WWDC25): 26개 언어(한국어 포함), 줄→문단 그룹핑, 표/리스트, 데이터 검출. CJK+태국어는 단어 단위 미지원(문단 단위는 OK).

**Fallback seam (선택)**
- Gemini: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, 헤더 `x-goog-api-key`. `gemini-flash-latest` = 현 `gemini-3.5-flash`.
- Argos: 오프라인 FOSS. 모델 호스트 `argos-net.com`(일부 샌드박스에서 차단됨).

## 11. 프로토타입 prior art (파이썬)

리플로우 메커니즘 검증용으로 이미 만든 파이썬 프로토타입이 있다. Swift/Node 재구현 시 로직 참고용:
- `simple_pymupdf.py` — PyMuPDF만으로 추출→분류(제목/본문)→리플로우→CJK 렌더링→페이지네이션. 내장 `korea` 폰트 사용.
- `pdf_translate.py` — 동일 4단계(extract/classify/translate-seam/build)를 reportlab 출력으로.
- `compare_translate.py` — 원문 | Argos | Gemini 나란히 비교 하네스. 엔진 자동 감지, NDJSON 아님(PDF 표 출력).

핵심 패턴: **추출은 좌표만(주장 없음) → 분류에서 첫 주장(제목/본문) → 번역은 seam → 재구성은 리플로우.**

## 12. 온디바이스에서 해소할 열린 질문

1. 현재 macOS에서 `TranslationSession`의 non-SwiftUI 진입점이 존재하는가?
2. 무인 운용을 위한 언어 가용성/설치 감지(`LanguageAvailability`) 흐름.
3. translate-CLI를 별도 프로세스로 유지 vs node-swift 임베드 — **별도 프로세스 권장**(§6).
4. `VNRecognizeTextRequest` 유지 vs `RecognizeDocumentsRequest` 승격 — 표/문단 필요 여부로 결정.

## 13. 참고 자료

- `cbcruk/vision-ocr` (본인 모듈) — OCR 빌딩 블록.
- franzai `translate` CLI — TranslationSession-in-CLI 선례.
- WWDC24 "Meet the Translation API" / WWDC25 "Read documents using the Vision framework".
- Apple Docs: Translation, Vision "Recognizing Text in Images".

---

### 첫 명령 제안 (Claude Code)

> "§6의 마일스톤 1을 구현하라: 숨은 SwiftUI View로 `TranslationSession`을 호스팅하는 독립 Swift CLI. stdin으로 문단 배열(JSON)을 받아 `translations(from:)`로 EN→KO 배치 번역하고, stdout에 NDJSON으로 순서대로 출력한 뒤 종료. franzai `translate` 패턴 참고. 먼저 이 macOS 버전에서 non-SwiftUI 진입점이 있는지 확인하고, 없으면 SwiftUI 호스팅으로 진행."
