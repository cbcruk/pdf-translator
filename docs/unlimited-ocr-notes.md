# 참고 노트: Baidu Unlimited-OCR

출처: https://github.com/baidu/Unlimited-OCR

pdf-translator에 참고할 만한 부분이 있는지 분석한 기록. 결론부터 —
**코드/파라미터 레벨에서 이식할 것은 거의 없고, 개념 하나("번역에 문맥을 넣어라")만 유효**하다.
그 실현 지점은 아직 미검증 상태인 `--engine gemini` 경로다.

## 두 프로젝트는 아키텍처 철학이 정반대

| | Unlimited-OCR (Baidu) | pdf-translator (현재) |
|---|---|---|
| 엔진 | VLM (DeepSeek-OCR 기반), GPU 필요 | Apple 프레임워크 (PDFKit / Vision / TranslationSession) |
| 실행 | vLLM·SGLang 서버, 32k 토큰 디코딩 | on-device, 오프라인, API 키 없음 |
| 문서 이해 | 모델이 레이아웃·읽기순서를 통째로 추론 | 기하학 기반 조립 + Vision `RecognizeDocumentsRequest` |
| 출력 | 구조화 텍스트(마크다운류) 파싱 | reflow 재조판(새 PDF) |
| 대상 | OCR/파싱 그 자체 | 번역 파이프라인의 한 단계로서의 추출 |

Unlimited-OCR의 핵심 스펙 대부분(32k 컨텍스트, `no_repeat_ngram_size=35` 반복 억제,
Gundam/Base 해상도 모드, vLLM/SGLang 배포)은 **VLM 디코딩 고유의 문제**다.
Apple Vision/NMT를 쓰는 현재 파이프라인엔 해당 사항이 없다.

## 건질 만한 개념 (우선순위 순)

### 1. 크로스-페이지/문단 번역 컨텍스트 — 제일 크고 실제로 유효

Unlimited-OCR의 정체성인 "one-shot long-horizon parsing"은 *페이지 간 맥락을 유지*한다는 것.
현재 pdf-translator는 문단 단위로 독립 번역한다 (문단당 ~1.5s, 문맥 공유 없음).

README에 적힌 알려진 한계 두 개가 정확히 **문맥 부재**에서 온다:

- `"Abstract" → "추상"` 같은 짧은 헤딩/셀 오역 (segment-level NMT 천장)
- 용어 일관성 (`--glossary`로 임시 완화 중)

Apple `TranslationSession`은 세그먼트 단위라 어쩔 수 없다. 하지만
**`--engine gemini` 경로에서는 한 페이지(또는 앞뒤 문단)를 컨텍스트로 함께 넣어 번역**하면
Baidu가 노리는 효과를 그대로 얻는다. `protect.ts`의 glossary/URL 마스킹과도 자연스럽게 결합된다.

→ gemini 경로를 "문단 단위 순차"가 아니라 "컨텍스트 포함 배치"로 설계할 근거.
관련 파일: `src/translator/llm-translator.ts`, `src/translator/translator.types.ts`

### 2. 배치/동시성 — apple엔 무의미, gemini엔 유효

README 설계노트의 "parallelism doesn't help"는 on-device 데몬이 직렬화하기 때문이다.
Unlimited-OCR의 concurrent request 모델은 **gemini 엔진에는 그대로 적용**된다.
llm-translator가 아직 라이브 API로 검증되지 않은 상태라, 붙일 때 문단 순차가 아니라
배치 + 동시 요청으로 가면 처리량 천장이 완전히 달라진다.

### 3. VLM을 "스캔/멀티컬럼 백엔드"로 두는 선택지 (선택적, 지금은 아님)

알려진 한계 중 "multi-column 레이아웃 읽기순서 미검증"은 기하학 기반 조립의 약점이다.
VLM은 읽기순서를 태생적으로 잘 잡는다. 다만 이건 **오프라인·no-API-key 설계 기둥과 정면충돌**하므로
지금 도입할 것은 아니다. "언젠가 클라우드 모드를 추가한다면 structure 스테이지의 대체 백엔드로"
정도의 메모. 파이프라인이 이미 JSON 계약으로 스테이지를 교체하게 되어 있어 seam은 이미 있다.
관련 파일: `src/pipeline/structure-blocks.ts`, `swift/pdf-cli/Sources/pdf-cli/Structure.swift`

## 참고하지 않아도 되는 것들

- 반복 억제(ngram) — Apple NMT는 이 실패모드가 거의 없음
- 32k 롱컨텍스트 디코딩 / Gundam·Base 해상도 모드 — VLM 전용
- PyMuPDF DPI 튜닝 — 이미 스캔 경로에서 3x 래스터라이즈로 처리 중 (`Structure.swift`의 `scale = 3.0`)

## 한 줄 요약

참고 가치는 **"번역에 문맥을 넣어라"** 하나로 수렴한다.
코드 이식이 아니라 **gemini 번역기의 설계 원칙**으로 반영하는 것이 맞다.
