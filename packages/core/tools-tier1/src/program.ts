import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawn } from '@jozo-harness/process'

/** What a wrapped command left behind, once it exits. */
export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** True when the program is an executable file, either on PATH or at an absolute path. */
export const programExists = (program: string): boolean => {
  if (program.includes('/')) {
    try {
      accessSync(program, constants.X_OK)
      return statSync(program).isFile()
    } catch {
      return false
    }
  }
  return (process.env.PATH ?? '').split(delimiter).some((directory) => {
    const candidate = join(directory, program)
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

/** Runs one argv and collects its output; a child that cannot start rejects here. */
export const runProcess = async (
  argv: ReadonlyArray<string>,
  cwd: string,
): Promise<CommandResult> => {
  const child = spawn([...argv], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

/** A thrown value as text, for a tool error message. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Keeps a failure's stderr a reason rather than a transcript. */
export const reasonOf = (stderr: string): string => {
  const trimmed = stderr.trim()
  if (trimmed === '') return 'no reason given'
  return trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed
}
