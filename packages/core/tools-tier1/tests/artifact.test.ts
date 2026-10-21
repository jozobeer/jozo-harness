import { Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeArtifactTool, type ArtifactValue } from '../src/index.ts'

const withHome = async (body: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'jzh-artifact-'))
  try {
    await body(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const publish = (
  home: string,
  name: string,
  html: string,
): Promise<{ value: ArtifactValue | undefined; added: ReadonlyArray<string> }> => {
  const added: Array<string> = []
  const tool = makeArtifactTool(home)
  return Effect.runPromise(
    Effect.match(
      tool.execute(
        { name, html },
        {
          sessionId: 's1',
          cwd: home,
          callId: 'c1',
          addContext: (text) => void added.push(text),
        },
      ),
      {
        onFailure: () => ({ value: undefined, added }),
        onSuccess: (value) => ({ value, added }),
      },
    ),
  )
}

describe('artifact tool', () => {
  test('writes the page under the jzh home, beside the sessions', async () => {
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

  test('renders the page url as one line of conversation', async () => {
    await withHome(async (home) => {
      const tool = makeArtifactTool(home)
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
      const tool = makeArtifactTool(home)
      for (const name of ['../escape', 'a/b', '', 'report html', '..']) {
        const exit = await Effect.runPromiseExit(
          tool.execute({ name, html: '<p>x</p>' }, { sessionId: 's1', cwd: home, callId: 'c1' }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }
      await expect(stat(join(home, 'artifacts'))).rejects.toThrow()
    })
  })
})
