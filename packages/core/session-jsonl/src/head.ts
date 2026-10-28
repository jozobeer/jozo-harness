import { open } from 'node:fs/promises'

/**
 * The first `maxBytes` of a file. A shorter file reads whole, and a character the
 * cut splits stays split: the callers only look for the endings they can see.
 */
export const readHeadBytes = async (path: string, maxBytes: number): Promise<Buffer> => {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** The first `maxBytes` of a plaintext file, decoded as UTF-8. */
export const readHead = async (path: string, maxBytes: number): Promise<string> =>
  (await readHeadBytes(path, maxBytes)).toString('utf8')
