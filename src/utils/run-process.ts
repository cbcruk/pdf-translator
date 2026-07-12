import { spawn } from 'node:child_process'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function runProcess(
  command: string,
  args: readonly string[],
  stdin?: string
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })

    if (stdin !== undefined) {
      child.stdin.write(stdin)
    }
    child.stdin.end()
  })
}
