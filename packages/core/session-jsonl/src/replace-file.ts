import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/**
 * Replaces the file by renaming a sibling over it. A crash while the new bytes
 * are written leaves the previous file in place, so repairing a log cannot
 * truncate the lines that were already complete.
 */
export const replaceFile = async (path: string, content: string | Uint8Array): Promise<void> => {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, path)
  } catch (cause) {
    await rm(temporary, { force: true })
    throw cause
  }
}
