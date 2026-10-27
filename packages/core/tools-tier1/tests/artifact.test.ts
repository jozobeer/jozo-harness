import { Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import type { ToolError } from '@jozo-harness/tools'
import { makeArtifactTool, type ArtifactResult } from '../src/index.ts'

const withHome = async (body: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'jzh-artifact-'))
  try {
    await body(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

const writeImage = async (home: string, path: string, bytes: Buffer): Promise<void> => {
  await mkdir(dirname(join(home, path)), { recursive: true })
  await writeFile(join(home, path), bytes)
}

const publish = (
  home: string,
  name: string,
  html: string,
  sandbox: SandboxShape = noneSandbox,
  images?: ReadonlyArray<string>,
): Promise<{
  value: ArtifactResult | undefined
  error: ToolError | undefined
  added: ReadonlyArray<string>
}> => {
  const added: Array<string> = []
  const tool = makeArtifactTool(join(home, 'sessions'), sandbox)
  return Effect.runPromise(
    Effect.match(
      tool.execute(
        { name, html, ...(images === undefined ? {} : { images }) },
        {
          sessionId: 's1',
          cwd: home,
          callId: 'c1',
          addContext: (text) => void added.push(text),
        },
      ),
      {
        onFailure: (error) => ({ value: undefined, error, added }),
        onSuccess: (value) => ({ value, error: undefined, added }),
      },
    ),
  )
}

const withMode = (mode: SandboxShape['mode']): SandboxShape => ({ ...noneSandbox, mode })

const declare = (
  home: string,
  deliverable: { path: string; title?: string },
  sandbox: SandboxShape = noneSandbox,
): Promise<{ value: ArtifactResult | undefined; error: ToolError | undefined }> => {
  const tool = makeArtifactTool(join(home, 'sessions'), sandbox)
  return Effect.runPromise(
    Effect.match(tool.execute({ deliverable }, { sessionId: 's1', cwd: home, callId: 'c1' }), {
      onFailure: (error) => ({ value: undefined, error }),
      onSuccess: (value) => ({ value, error: undefined }),
    }),
  )
}

describe('artifact tool', () => {
  test('writes the page beside the sessions root', async () => {
    await withHome(async (home) => {
      const { value } = await publish(home, 'report', '<h1>report</h1>')

      expect(await readFile(join(home, 'artifacts', 's1', 'report.html'), 'utf8')).toBe(
        '<h1>report</h1>',
      )
      expect(value).toEqual({
        sessionId: 's1',
        name: 'report',
        path: join(home, 'artifacts', 's1', 'report.html'),
        url: '/artifact/s1/report',
      })
    })
  })

  test('refuses to publish a page when the preset is read-only', async () => {
    await withHome(async (home) => {
      const { value, error } = await publish(
        home,
        'report',
        '<h1>report</h1>',
        withMode('read-only'),
      )

      expect(value).toBeUndefined()
      expect(error).toMatchObject({ code: 'denied' })
      expect(error?.message).toContain('read-only mode writes nothing')
      await expect(stat(join(home, 'artifacts'))).rejects.toThrow()
    })
  })

  test('publishes a page when the preset lets the run write', async () => {
    await withHome(async (home) => {
      const { value, error } = await publish(
        home,
        'report',
        '<h1>report</h1>',
        withMode('workspace-write'),
      )

      expect(error).toBeUndefined()
      expect(value).toMatchObject({ url: '/artifact/s1/report' })
      expect(await readFile(join(home, 'artifacts', 's1', 'report.html'), 'utf8')).toBe(
        '<h1>report</h1>',
      )
    })
  })

  test('renders the page url as one line of conversation', async () => {
    await withHome(async (home) => {
      const tool = makeArtifactTool(join(home, 'sessions'))
      const { value } = await publish(home, 'report', '<h1>report</h1>')

      expect(tool.output.render({ name: 'report', html: '<h1>report</h1>' }, value!)).toEqual([
        { type: 'text', text: 'page: /artifact/s1/report' },
      ])
    })
  })

  test('adds the page url to the next request', async () => {
    await withHome(async (home) => {
      const { added } = await publish(home, 'report', '<h1>report</h1>')

      expect(added).toEqual(['/artifact/s1/report'])
    })
  })

  test('refuses a name the artifact route would not serve', async () => {
    await withHome(async (home) => {
      const tool = makeArtifactTool(join(home, 'sessions'))
      for (const name of ['../escape', 'a/b', '', 'report html', '..']) {
        const exit = await Effect.runPromiseExit(
          tool.execute({ name, html: '<p>x</p>' }, { sessionId: 's1', cwd: home, callId: 'c1' }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }
      await expect(stat(join(home, 'artifacts'))).rejects.toThrow()
    })
  })

  test('folds the images it is given into data urls', async () => {
    await withHome(async (home) => {
      await writeImage(home, 'shots/logo.png', PNG)
      const html = '<img src="shots/logo.png">'
      const { value, error } = await publish(home, 'report', html, noneSandbox, ['shots/logo.png'])

      expect(error).toBeUndefined()
      const dataUrl = 'data:image/png;base64,' + PNG.toString('base64')
      expect(await readFile(value!.path, 'utf8')).toBe('<img src="' + dataUrl + '">')
    })
  })

  test('refuses an image with an unsupported extension or a missing file', async () => {
    await withHome(async (home) => {
      const unsupported = await publish(home, 'report', '<p>x</p>', noneSandbox, ['logo.bmp'])
      expect(unsupported.value).toBeUndefined()
      expect(unsupported.error).toMatchObject({ code: 'invalid-arguments' })
      expect(unsupported.error?.message).toContain('logo.bmp')

      const missing = await publish(home, 'report', '<p>x</p>', noneSandbox, ['missing.png'])
      expect(missing.value).toBeUndefined()
      expect(missing.error).toMatchObject({ code: 'invalid-arguments' })
      expect(missing.error?.message).toContain('missing.png')

      await expect(stat(join(home, 'artifacts'))).rejects.toThrow()
    })
  })

  test('refuses one image over the 2MB limit', async () => {
    await withHome(async (home) => {
      await writeImage(home, 'big.png', Buffer.alloc(2 * 1024 * 1024 + 1))
      const { value, error } = await publish(home, 'report', '<img src="big.png">', noneSandbox, [
        'big.png',
      ])

      expect(value).toBeUndefined()
      expect(error).toMatchObject({ code: 'invalid-arguments' })
      expect(error?.message).toContain('big.png')
      expect(error?.message).toContain('2MB')
    })
  })

  test('refuses images over the 10MB total', async () => {
    await withHome(async (home) => {
      const names = Array.from({ length: 6 }, (_, index) => 'shot' + index + '.png')
      for (const name of names) await writeImage(home, name, Buffer.alloc(2 * 1024 * 1024))
      const html = names.map((name) => '<img src="' + name + '">').join('')
      const { value, error } = await publish(home, 'report', html, noneSandbox, names)

      expect(value).toBeUndefined()
      expect(error).toMatchObject({ code: 'invalid-arguments' })
      expect(error?.message).toContain('shot5.png')
      expect(error?.message).toContain('10MB')
    })
  })

  test('leaves only the paths in the result the model sees', async () => {
    await withHome(async (home) => {
      await writeImage(home, 'logo.png', PNG)
      const tool = makeArtifactTool(join(home, 'sessions'))
      const args = { name: 'report', html: '<img src="logo.png">', images: ['logo.png'] }
      const { value } = await publish(home, 'report', args.html, noneSandbox, args.images)

      const content = tool.output.render(args, value!)
      expect(content).toEqual([{ type: 'text', text: 'page: /artifact/s1/report' }])
      expect(JSON.stringify(content)).not.toContain('base64')
    })
  })

  test('refuses a page that loads a file from outside itself', async () => {
    await withHome(async (home) => {
      const url = 'https://example.com/a.png'
      const { value, error } = await publish(home, 'report', '<img src="' + url + '">')

      expect(value).toBeUndefined()
      expect(error).toMatchObject({ code: 'invalid-arguments' })
      expect(error?.message).toContain(url)
      await expect(stat(join(home, 'artifacts'))).rejects.toThrow()
    })
  })

  test('refuses a page that loads a file over a protocol-relative url', async () => {
    await withHome(async (home) => {
      const url = '//cdn.example.com/x.css'
      const { value, error } = await publish(home, 'report', '<link href="' + url + '">')

      expect(value).toBeUndefined()
      expect(error).toMatchObject({ code: 'invalid-arguments' })
      expect(error?.message).toContain(url)
    })
  })

  test('refuses an outside reference from every element that can load one', async () => {
    await withHome(async (home) => {
      const url = 'https://example.com/a.png'
      const pages = [
        '<img src="' + url + '">',
        '<script src="' + url + '"></script>',
        '<link href="' + url + '">',
        '<iframe src="' + url + '"></iframe>',
        '<video src="' + url + '"></video>',
        '<video poster="' + url + '"></video>',
        '<audio src="' + url + '"></audio>',
        '<source src="' + url + '">',
        '<object data="' + url + '"></object>',
      ]
      for (const html of pages) {
        const { value, error } = await publish(home, 'report', html)
        expect(value, html).toBeUndefined()
        expect(error, html).toMatchObject({ code: 'invalid-arguments' })
        expect(error?.message, html).toContain(url)
      }
    })
  })

  test('publishes a page whose references stay inside the document', async () => {
    await withHome(async (home) => {
      const html =
        '<img src="data:image/png;base64,AAAA"><a href="#top">top</a><a href="/artifact/s1/other">other</a>'
      const { value, error } = await publish(home, 'report', html)

      expect(error).toBeUndefined()
      expect(await readFile(value!.path, 'utf8')).toBe(html)
    })
  })

  test('declares an existing file inside the working directory', async () => {
    await withHome(async (home) => {
      await writeFile(join(home, 'report.md'), 'done')
      const { value, error } = await declare(home, { path: 'report.md', title: 'Report' })

      expect(error).toBeUndefined()
      expect(value).toEqual({ path: join(home, 'report.md'), title: 'Report' })
      await expect(stat(join(home, 'artifacts'))).rejects.toThrow()
    })
  })

  test('renders a declared file as its path on one line', async () => {
    await withHome(async (home) => {
      await writeFile(join(home, 'report.md'), 'done')
      const tool = makeArtifactTool(join(home, 'sessions'))
      const { value } = await declare(home, { path: 'report.md' })

      expect(tool.output.render({ deliverable: { path: 'report.md' } }, value!)).toEqual([
        { type: 'text', text: 'deliverable: ' + join(home, 'report.md') },
      ])
    })
  })

  test('refuses a path outside the working directory', async () => {
    await withHome(async (home) => {
      const outside = await mkdtemp(join(tmpdir(), 'jzh-artifact-outside-'))
      try {
        await writeFile(join(outside, 'secret.txt'), 'x')
        const { value, error } = await declare(home, { path: join(outside, 'secret.txt') })

        expect(value).toBeUndefined()
        expect(error).toMatchObject({ code: 'invalid-arguments' })
        expect(error?.message).toContain('working directory')
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  test('refuses a missing path and a directory', async () => {
    await withHome(async (home) => {
      const missing = await declare(home, { path: 'missing.md' })
      expect(missing.value).toBeUndefined()
      expect(missing.error).toMatchObject({ code: 'invalid-arguments' })
      expect(missing.error?.message).toContain('missing.md')

      await mkdir(join(home, 'folder'))
      const directory = await declare(home, { path: 'folder' })
      expect(directory.value).toBeUndefined()
      expect(directory.error).toMatchObject({ code: 'invalid-arguments' })
      expect(directory.error?.message).toContain('folder')
    })
  })

  test('refuses an image the page never references', async () => {
    await withHome(async (home) => {
      await writeImage(home, 'logo.png', PNG)
      const { value, error } = await publish(home, 'report', '<p>x</p>', noneSandbox, ['logo.png'])

      expect(value).toBeUndefined()
      expect(error).toMatchObject({ code: 'invalid-arguments' })
      expect(error?.message).toContain('logo.png')
      await expect(stat(join(home, 'artifacts'))).rejects.toThrow()
    })
  })
})
