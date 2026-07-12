# translate-cli

On-device batch translation CLI built on Apple's Translation framework. The Node orchestrator shells out to it (spec §4, §6).

## Key finding (resolves spec §12-1)

**macOS 26.0+ has a non-SwiftUI entry point**: `TranslationSession(installedSource:target:)`
(`@available(iOS 26.0, macOS 26.0, *)`). The hidden-SwiftUI-view + run-loop hosting the spec assumed in §6 is unnecessary.

Constraint: as the name says, this initializer only works when the **language packs are already installed**. Presenting the download sheet still requires SwiftUI's `.translationTask`, so when packs are missing the CLI fails with exit 2 and instructions (consistent with spec §7-2's "preinstall for headless use").

## Usage

```sh
swift build

# Check language pair availability
./.build/debug/translate-cli --check
# → {"status":"installed","source":"en","target":"ko"}

# Batch translation: JSON array on stdin → NDJSON on stdout (input order preserved)
echo '["Hello, world."]' | ./.build/debug/translate-cli --source en --target ko
# → {"index":0,"sourceText":"Hello, world.","targetText":"안녕하세요, 세계."}
```

## Protocol

- **Input**: JSON array of strings on stdin (paragraph-sized — never single lines, spec §8)
- **Output**: one JSON object per line on stdout, `{"index","sourceText","targetText"}`, in input order
- **Exit codes**: `0` success · `1` usage/input error · `2` language pack not installed · `3` unsupported pair · `4` translation failure
- Diagnostics go to stderr only (stdout is NDJSON-only)

## Performance notes

Measured on macOS 26.5.1 / Apple Silicon: a 50-paragraph batch (~30 words each) ≈ 77s (~1.5s per paragraph).
Parallel processes don't help — on-device translation is serialized at the system daemon level.
For long documents, the orchestrator should show progress or chunk the batches.
