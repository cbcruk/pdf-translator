import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

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
