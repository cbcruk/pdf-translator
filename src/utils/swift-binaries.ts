import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** dist/ 기준 두 단계 위 = 리포 루트. Swift 빌드 산출물의 기준 경로다. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * `swift/<packageName>/.build/{release,debug}/<packageName>` 중 존재하는 것을 찾아
 * 가장 최근에 빌드된 바이너리 경로를 돌려준다. release/debug를 모두 뒤져 최신을 고르므로
 * 개발 중 debug 빌드가 release보다 새로우면 그쪽을 쓴다.
 *
 * @param packageName Swift 패키지 겸 실행 파일 이름 (예: `pdf-cli`, `translate-cli`)
 * @returns 실행 가능한 바이너리의 절대 경로
 * @throws 두 구성 모두에서 바이너리를 찾지 못하면 `pnpm build:swift` 안내와 함께 던진다
 */
export function resolveSwiftBinary(packageName: string): string {
  const candidates: Array<{ binary: string; modifiedAt: number }> = []
  for (const configuration of ['release', 'debug']) {
    const binary = path.join(repoRoot, 'swift', packageName, '.build', configuration, packageName)
    try {
      candidates.push({ binary, modifiedAt: statSync(binary).mtimeMs })
    } catch {
      continue
    }
  }

  const newest = candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)[0]
  if (newest === undefined) {
    throw new Error(`${packageName} binary not found. Run: pnpm build:swift`)
  }
  return newest.binary
}
