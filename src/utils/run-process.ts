import { spawn } from 'node:child_process'

/** 자식 프로세스의 실행 결과. stdout/stderr는 UTF-8로 모두 수집된 뒤 반환된다. */
export interface ProcessResult {
  stdout: string
  stderr: string
  /** 프로세스 종료 코드. 신호로 죽는 등 코드를 못 받은 경우 -1. */
  exitCode: number
}

/**
 * 자식 프로세스를 실행하고 종료될 때까지 기다려 stdout/stderr 전체를 모아 돌려준다.
 * Swift CLI들과 JSON을 주고받는 얇은 shell-out 배선이다.
 *
 * @param command 실행할 바이너리 경로
 * @param args 명령줄 인자
 * @param stdin 표준입력으로 흘려보낼 문자열 (없으면 빈 stdin으로 즉시 닫는다)
 * @returns 수집된 stdout/stderr와 종료 코드. 스폰 자체가 실패하면 reject된다.
 */
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
