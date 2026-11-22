import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import {
  ABSENT,
  recordOf,
  RemoteError,
  remoteFileSystem,
  runRemote,
  shellQuote,
  type RemoteHost,
} from '../src/index.ts'

/**
 * A host whose shell is this machine's: the programs are the ones ssh would run
 * on a remote POSIX host, so this exercises them without a server. The one
 * thing it does not exercise is the ssh invocation itself.
 */
const localHost = (cwd: string): RemoteHost => ({
  cwd,
  shell: (program) => ['sh', '-c', program, 'jzh'],
})

const seamOf = (cwd: string) => {
  const host = localHost(cwd)
  return { host, fileSystem: remoteFileSystem(host) }
}

describe('the file seam over a remote shell', () => {
  test('reads a file the host holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    await writeFile(join(dir, 'notes.txt'), 'the notes\n')
    const { fileSystem } = seamOf(dir)

    const bytes = await Effect.runPromise(fileSystem.readBytes(join(dir, 'notes.txt')))

    expect(new TextDecoder().decode(bytes)).toBe('the notes\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('a file that is not there says so with the host exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    const { fileSystem, host } = seamOf(dir)

    const read = await Effect.runPromise(Effect.result(fileSystem.readBytes(join(dir, 'nope.txt'))))
    const state = await Effect.runPromise(fileSystem.stat(join(dir, 'nope.txt')))
    const listed = await runRemote(host, 'exit ' + String(ABSENT))

    expect(read._tag).toBe('Failure')
    expect(JSON.stringify(read)).toContain('no such file on the remote host')
    expect(state).toBeUndefined()
    expect(listed.exitCode).toBe(ABSENT)
    await rm(dir, { recursive: true, force: true })
  })

  test('reads a state, a listing, and a digest without sending the bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'a.ts'), 'const one = 1\n')
    await writeFile(join(dir, 'src', 'b.ts'), 'const two = 2\n')
    const { fileSystem } = seamOf(dir)

    const state = await Effect.runPromise(fileSystem.stat(join(dir, 'src')))
    const entries = await Effect.runPromise(fileSystem.readdir(join(dir, 'src')))
    const seen = await Effect.runPromise(fileSystem.observe(join(dir, 'src', 'a.ts')))

    expect(state).toMatchObject({ isDirectory: true, isFile: false, isSymbolicLink: false })
    expect(entries.map((entry) => entry.name).sort()).toEqual(['a.ts', 'b.ts'])
    expect(entries.every((entry) => entry.isFile)).toBe(true)
    expect(seen?.bytes).toBe(14)
    expect(seen?.digest).toMatch(/^[0-9a-f]{64}$/)
    await rm(dir, { recursive: true, force: true })
  })

  test('a link is reported as a link, which is what a confinement asks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    const target = join(tmpdir(), 'jozo-harness-ssh-target-' + String(process.pid))
    await writeFile(target, 'outside\n')
    await runRemote(
      localHost(dir),
      'ln -s ' + shellQuote(target) + ' ' + shellQuote(join(dir, 'out')),
    )
    const { fileSystem } = seamOf(dir)

    const link = await Effect.runPromise(fileSystem.lstat(join(dir, 'out')))

    expect(link?.isSymbolicLink).toBe(true)
    await rm(dir, { recursive: true, force: true })
    await rm(target, { force: true })
  })

  test('stages bytes beside the target and only publishes them at commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    await writeFile(join(dir, 'notes.txt'), 'old\n')
    const { fileSystem } = seamOf(dir)

    const staged = await Effect.runPromise(fileSystem.stage(join(dir, 'notes.txt'), 'new\n'))
    const beforeCommit = await readFile(join(dir, 'notes.txt'), 'utf8')
    await Effect.runPromise(staged.commit)
    const afterCommit = await readFile(join(dir, 'notes.txt'), 'utf8')

    expect(beforeCommit).toBe('old\n')
    expect(afterCommit).toBe('new\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('a discarded staged write leaves the file and no temporary file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    await writeFile(join(dir, 'notes.txt'), 'old\n')
    const { fileSystem } = seamOf(dir)

    const staged = await Effect.runPromise(fileSystem.stage(join(dir, 'notes.txt'), 'new\n'))
    await Effect.runPromise(staged.discard)
    const names = await Effect.runPromise(fileSystem.readdir(dir))
    await Effect.runPromise(staged.discard)

    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('old\n')
    expect(names.map((entry) => entry.name)).toEqual(['notes.txt'])
    await rm(dir, { recursive: true, force: true })
  })

  test('creates parent directories the way a write needs them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    const { fileSystem } = seamOf(dir)

    await Effect.runPromise(fileSystem.mkdirp(join(dir, 'deep', 'tree')))
    const state = await Effect.runPromise(fileSystem.stat(join(dir, 'deep', 'tree')))

    expect(state?.isDirectory).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test('a host that cannot be reached is an error, not an empty read', async () => {
    const host: RemoteHost = {
      cwd: '/nowhere',
      shell: () => ['jzh-command-that-does-not-exist'],
    }

    await expect(runRemote(host, 'true')).rejects.toThrow('cannot reach the remote host')
  }, 10_000)
})

describe('the record a program prints', () => {
  test('a field line is read as its key and value, and the body starts at the marker', () => {
    const record = recordOf('__jzh__ kind f\n__jzh__ size 6\n__jzh__ data\naGVsbG8K\n')

    expect(record.fields).toEqual({ kind: 'f', size: '6' })
    expect(record.body.trim()).toBe('aGVsbG8K')
  })

  test('a value with spaces keeps them', () => {
    const record = recordOf('__jzh__ name f a file with spaces.txt\n')

    expect(record.fields).toEqual({ name: 'f a file with spaces.txt' })
  })

  test('a program that prints nothing has no fields', () => {
    expect(recordOf('').fields).toEqual({})
  })

  test('a quote in a path survives the shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    const odd = join(dir, "it's here.txt")
    await writeFile(odd, 'quoted\n')
    const { fileSystem } = seamOf(dir)

    const bytes = await Effect.runPromise(fileSystem.readBytes(odd))

    expect(new TextDecoder().decode(bytes)).toBe('quoted\n')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('a remote failure', () => {
  test('names the host when the program exited without a message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    const host = localHost(dir)

    const result = await runRemote(host, 'exit 7')

    expect(result.exitCode).toBe(7)
    expect(new RemoteError('x').exitCode).toBe(255)
    await rm(dir, { recursive: true, force: true })
  })

  test('a program that outlives the timeout is killed and reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-'))
    const host: RemoteHost = { ...localHost(dir), timeoutMs: 300 }

    await expect(runRemote(host, 'sleep 5')).rejects.toThrow('timed out after 300ms')
    await rm(dir, { recursive: true, force: true })
  })
})
