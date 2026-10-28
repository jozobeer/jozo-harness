import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'

/** How long one Office conversion may take before the page gives up on it. */
export const CONVERT_TIMEOUT = 30_000

/**
 * Turns one Office file into PDF bytes, or fails with the reason it could not.
 * The bytes are what the reader already holds, so a converter never has to touch
 * the workspace file.
 */
export type OfficeConverter = (
  bytes: Buffer,
  extension: string,
) => Effect.Effect<Buffer | undefined, Error>

/** Runs a converter over one source in a scratch folder; tests replace it. */
export type OfficeRun = (source: string, directory: string) => Promise<void>

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** LibreOffice, headless: it writes <name>.pdf beside the source it was given. */
const runSoffice: OfficeRun = (source, directory) =>
  new Promise((resolve, reject) => {
    execFile(
      'soffice',
      ['--headless', '--convert-to', 'pdf', '--outdir', directory, source],
      { timeout: CONVERT_TIMEOUT },
      (error) => (error === null ? resolve() : reject(new Error(messageOf(error)))),
    )
  })

/**
 * A converter built on one runner: the source is written to a scratch folder so
 * the workspace file is only ever read, and the folder goes away whether the
 * run succeeds or not. No converter on the host fails before any file is written.
 */
export const officeToPdfWith =
  (run: OfficeRun): OfficeConverter =>
  (bytes, extension) =>
    Effect.tryPromise({
      try: async () => {
        const directory = await mkdtemp(join(tmpdir(), 'jzh-office-'))
        const source = join(directory, 'input' + extension)
        try {
          await writeFile(source, bytes)
          await run(source, directory)
          return await readFile(join(directory, 'input.pdf'))
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
      catch: (error) =>
        new Error(
          'this host cannot convert ' + extension.slice(1) + ' to PDF: ' + messageOf(error),
        ),
    })

export const officeToPdf: OfficeConverter = officeToPdfWith(runSoffice)
