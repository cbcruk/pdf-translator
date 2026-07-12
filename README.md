# pdf-translator

On-device PDF translator for macOS (EN→KO by default, reflow-based). Instead of reproducing the original layout, it restores reading order and pours the translated text into a clean new PDF — the bar is "as readable as Chrome's reader mode." Works fully offline with no API keys. See [PDF-Translator-Spec.md](PDF-Translator-Spec.md) for the design background.

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

## Layout

Two Swift CLIs sit at the Apple framework boundaries (spec §4); the Node orchestrator ([src/cli.ts](src/cli.ts)) drives them in pipeline order. Every arrow between stages is a JSON contract, so any stage can be swapped independently.

| Stage | Module | Role |
|---|---|---|
| Detect | `pdf-cli info` (Swift) | does a text layer exist? |
| Extract | `pdf-cli extract` (Swift) | per-line text + bbox + font size/bold |
| — scanned path | `pdf-cli structure` (Swift) + [structure-blocks.ts](src/pipeline/structure-blocks.ts) | `RecognizeDocumentsRequest` paragraphs/titles/tables/lists → blocks directly |
| Assemble | [assemble.ts](src/pipeline/assemble.ts) / [assemble.utils.ts](src/pipeline/assemble.utils.ts) | lines → paragraph/heading/table blocks; header/footer & ToC removal, URL rejoining |
| Enrich tables | [enrich-tables.ts](src/pipeline/enrich-tables.ts) + `pdf-cli structure` (Swift) | attach Vision cell structure to geometry-detected tables (table pages only) |
| Protect | [protect.ts](src/pipeline/protect.ts) | mask URLs/emails/glossary terms as `⟦U0⟧` tokens; restore after translation |
| Translate | [apple-translator.ts](src/translator/apple-translator.ts) \| [llm-translator.ts](src/translator/llm-translator.ts) | engine seam ([translator.types.ts](src/translator/translator.types.ts), spec §8): `translate-cli` (Swift) on-device \| Gemini API |
| Render | [render.ts](src/pipeline/render.ts) → `pdf-cli render` (Swift) | block-by-block layout, table grids, pagination |

Shell-out plumbing lives in [ingest.ts](src/pipeline/ingest.ts) and [src/utils/](src/utils/).

## How it works

**Paragraph assembly** — Translation quality comes from paragraph-level context (spec §5-3), so grouping lines into paragraphs correctly is the core job. Using document-wide statistics (median line gap, common left-edge alignments, dominant body font size), paragraphs break on vertical gaps (1.35×), font changes, indentation, and bullet markers. Headers/footers, page numbers, rotated text (arXiv stamps), and ToC dot leaders are stripped before assembly.

**Tables** — A run of 3+ consecutive lines sharing an x-offset away from the body alignment marks a table's position; Vision `structure` then runs on those pages only to recover cell structure. Only cells containing words are translated, and the renderer draws real grids (borders, automatic column widths, in-cell wrapping). If Vision matching fails, the table degrades gracefully to monospaced text.

**Protected spans** — URLs, emails, bare domains, and glossary terms are swapped for `⟦U0⟧` tokens before translation and restored afterwards (empirically verified that Apple NMT passes the tokens through untouched). URLs split across lines by typesetting (including right after `https:`) are rejoined at line and block boundaries.

**Scanned documents** — Without a text layer, pages are rasterized at 3x and `RecognizeDocumentsRequest` returns pre-grouped paragraphs/titles/tables/lists that map directly to blocks (no line assembly; completes the spec §5-2/§12-4 upgrade).

## Design notes (deviations from the spec, with measurements)

- **No SwiftUI hosting needed**: the spec's biggest unknown (§6, TranslationSession's SwiftUI coupling) is resolved by macOS 26.0+'s `init(installedSource:target:)`. The language-pack download UI is still SwiftUI-only, so packs must be preinstalled
- **OCR via pdf-cli subcommand instead of node-swift in-process binding**: assembly is geometry-based and needs per-line bboxes, which the existing `vision-ocr` module doesn't provide (spec §9). The JSON contract is the seam, so switching back is cheap
- **Parallelism doesn't help**: running 2–3 translate-cli processes concurrently takes exactly as long as one — on-device translation is serialized at the system daemon level. The throughput ceiling is ~1.5s per paragraph; the real fix is `--engine gemini`
- **Render fonts**: Helvetica Neue with an Apple SD Gothic Neo cascade. Drawing Latin with SD Gothic alone loses doubled letters (`ll` → `l`) on extraction round-trips, and `NSFont.systemFont` embeds private font names that fall back to Times in other viewers

## Known limitations

- Multi-column (2-column) layouts depend on PDFKit/Vision reading order — not validated
- Vision cell recognition sometimes merges dense header rows, and tables spanning a page break render as two grids
- Mistranslation of short headings/cells ("Abstract" → "추상") is a segment-level NMT ceiling — mitigate with `--glossary`, solve with `--engine gemini`
- `--engine gemini` has not yet been exercised against the live API (requires a key)
