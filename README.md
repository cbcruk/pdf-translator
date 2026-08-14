# pdf-translator

On-device PDF translator for macOS (EN→KO by default, reflow-based). Instead of reproducing the original layout, it restores reading order and pours the translated text into a clean new PDF — the bar is "as readable as Chrome's reader mode." Works fully offline with no API keys. The original handoff spec is preserved in git history (`PDF-Translator-Spec.md`, initial commit).

```
PDF ─ has text layer ─▶ extract (PDFKit: lines + bbox + font)
   │                      └▶ geometry-based paragraph assembly ─▶ Vision cell structure for table pages only
   └─ scanned ────────▶ structure (RecognizeDocumentsRequest: paragraphs/titles/tables/lists)
                                   │
             URL & glossary masking ─▶ translate (Apple on-device | Gemini) ─▶ restore
                                   │
                render (block layout + table grids, OS-bundled Korean fonts)
```

## Requirements

- **macOS 26.0+** — uses the direct `TranslationSession(installedSource:target:)` entry point and `RecognizeDocumentsRequest`
- Node 18+, pnpm, Swift toolchain (Xcode Command Line Tools)
- Translation language packs preinstalled: System Settings > General > Language & Region > Translation Languages (exits with code 2 and instructions if missing)

## Build & Usage

```sh
pnpm install
pnpm build:swift   # translate-cli, pdf-cli (release)
pnpm build         # TypeScript → dist/

node dist/cli.js input.pdf
```

| Option | Description |
|---|---|
| `-o, --output <path>` | Output path (default: `input.ko.pdf`) |
| `--source`, `--target` | Language pair (default: `en` → `ko`) |
| `--pages N[-M]` | Translate only the given pages (useful for long documents at ~1.5s per paragraph) |
| `--glossary terms.json` | Pin terminology: `{"sub-threshold": "서브 임계"}` — consistent terms across the document |
| `--engine apple\|gemini` | Translation engine. `gemini` requires the `GEMINI_API_KEY` env var (default: `apple`, on-device) |
| `--extractor apple\|pdfjs` | Text-layer extraction backend. `pdfjs` uses unpdf (PDF.js), a cross-platform alternative to the Swift/PDFKit path — no bold detection (see design notes). Default: `apple` |
| `--renderer swift\|js` | PDF rendering backend. `js` uses pdf-lib, a cross-platform alternative to the Swift/Core Graphics path. Korean output needs a CJK font via `--font` (see design notes). Default: `swift` |
| `--font <path.otf>` | CJK font (`.otf`/`.ttf`) for `--renderer js` to draw Korean. Also read from `PDF_TRANSLATOR_FONT`. e.g. Noto Sans KR |

## Layout

Two Swift CLIs sit at the Apple framework boundaries; the Node orchestrator ([src/cli.ts](src/cli.ts)) drives them in pipeline order. Every arrow between stages is a JSON contract, so any stage can be swapped independently.

| Stage | Module | Role |
|---|---|---|
| Detect | `pdf-cli info` (Swift) | does a text layer exist? |
| Extract | `pdf-cli extract` (Swift) — or [extract-pdfjs.ts](src/pipeline/extract-pdfjs.ts) via `--extractor pdfjs` | per-line text + bbox + font size/bold |
| — scanned path | `pdf-cli structure` (Swift) + [structure-blocks.ts](src/pipeline/structure-blocks.ts) | `RecognizeDocumentsRequest` paragraphs/titles/tables/lists → blocks directly |
| Assemble | [assemble.ts](src/pipeline/assemble.ts) / [assemble.utils.ts](src/pipeline/assemble.utils.ts) | lines → paragraph/heading/table blocks; header/footer & ToC removal, URL rejoining |
| Enrich tables | [enrich-tables.ts](src/pipeline/enrich-tables.ts) + `pdf-cli structure` (Swift) | attach Vision cell structure to geometry-detected tables (table pages only) |
| Protect | [protect.ts](src/pipeline/protect.ts) | mask URLs/emails/glossary terms as `⟦U0⟧` tokens; restore after translation |
| Translate | [apple-translator.ts](src/translator/apple-translator.ts) \| [llm-translator.ts](src/translator/llm-translator.ts) | engine seam ([translator.types.ts](src/translator/translator.types.ts)): `translate-cli` (Swift) on-device \| Gemini API |
| Render | [render.ts](src/pipeline/render.ts) → `pdf-cli render` (Swift) — or [render-js.ts](src/pipeline/render-js.ts) via `--renderer js` | block-by-block layout, table grids, pagination |

Shell-out plumbing lives in [ingest.ts](src/pipeline/ingest.ts) and [src/utils/](src/utils/).

## How it works

**Paragraph assembly** — Translation quality comes from paragraph-level context, so grouping lines into paragraphs correctly is the core job. Using document-wide statistics (median line gap, common left-edge alignments, dominant body font size), paragraphs break on vertical gaps (1.35×), font changes, indentation, and bullet markers. Headers/footers, page numbers, rotated text (arXiv stamps), and ToC dot leaders are stripped before assembly.

**Tables** — A run of 3+ consecutive lines sharing an x-offset away from the body alignment marks a table's position; Vision `structure` then runs on those pages only to recover cell structure. Only cells containing words are translated, and the renderer draws real grids (borders, automatic column widths, in-cell wrapping). If Vision matching fails, the table degrades gracefully to monospaced text.

**Protected spans** — URLs, emails, and bare domains are swapped for `⟦U0⟧` tokens before translation and restored afterwards (empirically verified that Apple NMT passes the tokens through untouched). URLs split across lines by typesetting (including right after `https:`) are rejoined at line and block boundaries. Glossary terms are masked the same way on the Apple path; on the Gemini path they are passed as prompt instructions instead (see below), so the model can inflect them naturally rather than substituting a fixed string.

**Gemini context batching** — The `--engine gemini` path translates in batches (≤20 units, split on page boundaries) rather than one segment at a time. Each request carries a read-only CONTEXT block — the section heading plus the preceding source paragraphs — so short headings and boundary paragraphs are disambiguated by their surroundings (this is what makes `Abstract → 초록` beat the isolated `Abstract → 추상`). Context is drawn from *source* text, not prior translations, so batches stay independent and run concurrently (4 at a time). The glossary is injected as an instruction (`term → 번역`). Count-mismatch or API failures split the batch in half and retry, falling back to the source string for a single unit that still fails, so a partial failure never sinks the whole document.

**Scanned documents** — Without a text layer, pages are rasterized at 3x and `RecognizeDocumentsRequest` returns pre-grouped paragraphs/titles/tables/lists that map directly to blocks (no line assembly).

## Design notes (deviations from the spec, with measurements)

- **No SwiftUI hosting needed**: the design's biggest unknown (TranslationSession's SwiftUI coupling) is resolved by macOS 26.0+'s `init(installedSource:target:)`. The language-pack download UI is still SwiftUI-only, so packs must be preinstalled
- **OCR via pdf-cli subcommand instead of node-swift in-process binding**: assembly is geometry-based and needs per-line bboxes, which the existing `vision-ocr` module doesn't provide (it returns a flat transcript). The JSON contract is the seam, so switching back is cheap
- **Parallelism doesn't help on-device, but it does over the API**: running 2–3 translate-cli processes concurrently takes exactly as long as one — Apple's on-device translation is serialized at the system daemon level (~1.5s per paragraph ceiling). The Gemini path has no such serialization, so it runs batches concurrently — the real throughput fix
- **Render fonts**: Helvetica Neue with an Apple SD Gothic Neo cascade. Drawing Latin with SD Gothic alone loses doubled letters (`ll` → `l`) on extraction round-trips, and `NSFont.systemFont` embeds private font names that fall back to Times in other viewers
- **`--extractor pdfjs` (unpdf) as a cross-platform spike**: PDF.js emits text *items* (runs), not lines, so [extract-pdfjs.ts](src/pipeline/extract-pdfjs.ts) regroups them into lines by `hasEOL` + baseline jumps — work PDFKit does for free. It shares the same bottom-left coordinate system, so the `ExtractedLine` contract is a drop-in seam. Verified end-to-end on Linux (extract → assemble → blocks) with no Swift. The catch: unpdf exposes only a generic `fontFamily` (`"sans-serif"`), so `bold` is always false — size-based heading detection survives, bold-only headings don't. Kept behind a flag, not the default, because structure (Vision) and render (Core Graphics) still pin the tool to macOS. See [docs/unpdf-notes.md](docs/unpdf-notes.md)
- **`--renderer js` (pdf-lib) completes the cross-platform path**: with `--extractor pdfjs --engine gemini --renderer js`, a text-layer PDF translates EN→KO with no macOS. [render-js.ts](src/pipeline/render-js.ts) mirrors the Swift renderer's metrics (Letter, 64pt margin, 11/16/9pt fonts, grid tables, bottom-left pagination). Korean needs a fontkit-embeddable single-file CJK font (`.otf`/`.ttf`) via `--font`; Noto Sans KR with `subset:true` embeds in ~30KB and round-trips exactly (verified end-to-end on Linux, headings/body/tables/URLs). Limits: single font weight (headings differ by size only, no bold cascade), `.ttc`/unifont not embeddable, and the fallback Helvetica is WinAnsi-only (errors on Korean without a font). Scanned PDFs still need Vision, so full cross-platform is text-layer-only. See [docs/js-renderer-notes.md](docs/js-renderer-notes.md)

## Known limitations

- Multi-column (2-column) layouts depend on PDFKit/Vision reading order — not validated
- Vision cell recognition sometimes merges dense header rows, and tables spanning a page break render as two grids
- Mistranslation of short headings/cells ("Abstract" → "추상") is a segment-level NMT ceiling on the Apple path — mitigate with `--glossary`, or switch to `--engine gemini`, whose context batching translates each segment against its section heading and surrounding text
- `--engine gemini`'s batching, context assembly, and glossary injection are covered by a mocked-transport test, but the path has not yet been exercised against the live Gemini API (requires a key)
